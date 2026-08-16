<#
.SYNOPSIS
  将 Virlen（Tauri 2 + React）项目打包成 MSIX 安装包。

.DESCRIPTION
  Tauri 2 的 bundler 只支持 MSI / NSIS，不直接生成 MSIX。
  本脚本通过 Windows SDK 工具链完成 MSIX 打包：

    1. 校验前置环境（node / pnpm / cargo / Windows SDK MakeAppx + SignTool）
    2. pnpm tauri build --no-bundle   构建 release 二进制（exe + DLL）
    3. 组装 MSIX 暂存目录
       - virlen-app.exe + 依赖 DLL（WebView2Loader / onnxruntime / DirectML 等）
       - resources/（技能、视觉模型、tokenizer 等运行时资源）
       - assets/  （Store 图标）
       - AppxManifest.xml
    4. MakeAppx.exe pack              生成 .msix
    5. SignTool.exe 签名              可指定证书，否则自动生成自签名开发证书

.PARAMETER SkipBuild
  跳过 pnpm tauri build，直接使用 src-tauri/target/release 已有产物。

.PARAMETER SkipSign
  不签名。注意：未签名的 .msix 无法安装，仅用于检查包内容。

.PARAMETER StoreMode
  以微软商店标准生成：在清单中声明 Microsoft.VCLibs.140.00.UWPDesktop 框架
  依赖（由商店自动补齐 VC 运行库）。
  注意：商店校验会拒绝裸 .msix 中声明的 Microsoft.WebView2 框架依赖（要求
  上传 .msixupload），因此默认【不】声明 WebView2，应用使用系统已安装的
  Evergreen WebView2 运行时（Win10/11 基本都有）。如需声明请加 -IncludeWebView2Dep。

.PARAMETER IncludeWebView2Dep
  在 StoreMode 下额外声明 Microsoft.WebView2 框架依赖。
  注意：声明该依赖时商店要求上传 .msixupload 文件（请同时加 -MakeMsixUpload），
  否则裸 .msix 上传会被拒绝（错误：声明的程序包依赖关系不存在）。

.PARAMETER MakeMsixUpload
  签名后额外生成 .msixupload 上传文件（zip：仅含 .msix）。
  微软商店要求：包含框架依赖的包必须以 .msixupload/.appxupload 提交。
  注意：.msixupload 内【不要】附带 .cer 证书，否则商店会报
  "The file *.cer is not supported. Remove or update this file."

.PARAMETER BundleVcRuntime
  从 Visual Studio VC143 redist 拷贝 VC 运行库 DLL 进包内（离线自包含），
  并移除 VCLibs 框架依赖。找不到 redist 时自动回退为声明框架依赖。

.PARAMETER NoTimestamp
  签名时不打时间戳（离线环境可避免时间戳服务器连接失败）。

.PARAMETER InstallCert
  签名后把证书导入"当前用户受信任根证书存储"，方便本机 Add-AppxPackage 安装。

.PARAMETER PfxPath
  签名证书 .pfx 路径。不提供时自动生成自签名开发证书。

.PARAMETER PfxPassword
  签名证书密码。

.PARAMETER OutDir
  输出目录，默认 <项目根>/dist/msix。

.PARAMETER IdentityName
  MSIX Identity Name，默认取 tauri.conf.json 的 identifier（JianWeichen.virlen）。

.PARAMETER PublisherName
  发布者，必须与签名证书 Subject 完全一致。默认取 bundle.publisher，
  若未以 "CN=" 开头则自动补全。
  【微软商店提交】必须使用 Partner Center 账号的 Publisher ID，例如：
    -PublisherName "CN=FC098557-0402-4540-8F07-A4879915B448"
  注意：商店校验要求清单 Publisher 与账号 Publisher ID 完全一致。

.PARAMETER Version
  4 段版本号（a.b.c.d），默认取 tauri.conf.json version 并补 ".0"。

.PARAMETER Language
  包资源语言，默认 zh-CN。

.PARAMETER Architecture
  包架构 x64 / x86 / arm64，默认取当前系统架构。

.EXAMPLE
  # 本地测试：构建 + 打包 + 自签名 + 信任证书 + 输出到 dist/msix
  powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1 -InstallCert

  # 使用已有证书
  powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1 `
      -PfxPath .\cert\Virlen.pfx -PfxPassword "yourpass"

  # 仅用已有产物重新打包，不签名（检查用）
  powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1 -SkipBuild -SkipSign

  # 微软商店提交（用 Partner Center 的 Identity 与 Publisher ID）
  powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1 `
      -StoreMode `
      -IdentityName JianWeichen.virlen `
      -PublisherName "CN=FC098557-0402-4540-8F07-A4879915B448"

.NOTES
  MSIX 要求：Windows 10 1809+，签名证书须包含代码签名 EKU(1.3.6.1.5.5.7.3.3)。
  安装 .msix 需开启"开发者模式/旁加载"，且签名证书须被信任。
  微软商店上传：清单 Identity / Publisher 必须与 Partner Center 账号一致，
  包含 WebView2 等框架依赖时必须上传 .msixupload（-MakeMsixUpload）。
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipSign,
    [switch]$StoreMode,
    [switch]$IncludeWebView2Dep,
    [switch]$MakeMsixUpload,
    [switch]$BundleVcRuntime,
    [switch]$NoTimestamp,
    [switch]$InstallCert,
    [string]$PfxPath = "",
    [string]$PfxPassword = "",
    [string]$OutDir = "",
    [string]$IdentityName = "",
    [string]$PublisherName = "",
    [string]$Version = "",
    [string]$Language = "zh-CN",
    [ValidateSet("x64", "x86", "arm64")][string]$Architecture = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "    [警告] $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "    [错误] $m" -ForegroundColor Red }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SrcTauri    = Join-Path $ProjectRoot "src-tauri"
$ConfigPath  = Join-Path $SrcTauri "tauri.conf.json"
$CargoPath   = Join-Path $SrcTauri "Cargo.toml"

# ============================================================
# 1. 读取项目配置
# ============================================================
if (-not (Test-Path $ConfigPath)) { Write-Err "找不到 $ConfigPath"; exit 1 }
$config      = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$productName = $config.productName
$confVersion = $config.version
$identifier  = $config.identifier
$publisher   = $config.bundle.publisher

if (-not $IdentityName) { $IdentityName = $identifier }
if (-not $PublisherName) { $PublisherName = $publisher }
if ($PublisherName -notmatch '^CN=') { $PublisherName = "CN=$PublisherName" }
if (-not $Version) { $Version = $confVersion }
if (($Version -split '\.').Count -lt 4) { $Version = "$Version.0" }

# StoreMode 下提醒使用 Partner Center 的 Publisher ID（形如 CN=FC098557-0402-4540-8F07-A4879915B448）
if ($StoreMode -and $PublisherName -notmatch '^CN=[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') {
    Write-Warn "StoreMode 下 PublisherName 不是 Partner Center Publisher ID 格式（如 CN=FC098557-0402-4540-8F07-A4879915B448），"
    Write-Warn "直接上传到商店可能被拒（错误：无效的软件包发布者名称）。"
    Write-Warn "请改用：-PublisherName \"CN=你的PublisherID\""
}

if (-not $Architecture) {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { $Architecture = "x64" }
        "ARM64" { $Architecture = "arm64" }
        default { $Architecture = "x86" }
    }
}

# 主程序名 = Cargo [package].name
$cargoLines = @()
if (Test-Path $CargoPath) {
    $cargoLines = [System.IO.File]::ReadAllLines($CargoPath, [System.Text.Encoding]::UTF8)
}
$exeName = "virlen-app"
foreach ($line in $cargoLines) {
    if ($line -match '^\s*name\s*=\s*"([^"]+)"\s*$') { $exeName = $Matches[1]; break }
}
$exeNameExe = "$exeName.exe"

# 描述（Cargo.toml 有中文描述；无则用占位）
$description = $config.description
if (-not $description) {
    $description = "Virlen - AI Agent Desktop"
    foreach ($line in $cargoLines) {
        if ($line -match '^\s*description\s*=\s*"([^"]+)"\s*$') { $description = $Matches[1]; break }
    }
}

if (-not $OutDir) { $OutDir = Join-Path $ProjectRoot "dist\msix" }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

Write-Step "配置摘要"
Write-Ok  "产品名    : $productName"
Write-Ok  "版本      : $Version"
Write-Ok  "Identity  : $IdentityName"
Write-Ok  "Publisher : $PublisherName"
Write-Ok  "架构      : $Architecture"
Write-Ok  "主程序    : $exeNameExe"
Write-Ok  "输出目录  : $OutDir"

# ============================================================
# 2. 校验前置环境
# ============================================================
function Find-SdkTool {
    param([string]$Name)
    $kitsRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (Test-Path $kitsRoot) {
        $versions = Get-ChildItem $kitsRoot -Directory |
            Sort-Object { try { [version]$_.Name } catch { 0 } } -Descending
        foreach ($v in $versions) {
            foreach ($arch in @("x64", "arm64", "x86")) {
                $p = Join-Path $v.FullName (Join-Path $arch $Name)
                if (Test-Path $p) { return $p }
            }
        }
    }
    $g = Get-Command $Name -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }
    return $null
}

Write-Step "检查前置环境"
$missing = @()
if (-not $SkipBuild) {
    foreach ($cmd in @("node", "pnpm", "cargo")) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { $missing += $cmd }
    }
}
$makeAppx = Find-SdkTool "MakeAppx.exe"
$signTool = Find-SdkTool "SignTool.exe"
if (-not $makeAppx) { $missing += "Windows SDK (MakeAppx.exe)" }
if (-not $SkipSign -and -not $signTool) { $missing += "Windows SDK (SignTool.exe)" }

if ($missing.Count -gt 0) {
    Write-Err "缺少必要工具：$($missing -join ', ')"
    Write-Warn "请安装 Windows 10 SDK（含打包/签名工具）："
    Write-Warn "  https://developer.microsoft.com/windows/downloads/windows-sdk/"
    exit 1
}
Write-Ok "MakeAppx : $makeAppx"
Write-Ok "SignTool : $signTool"

# ============================================================
# 3. 构建 Tauri release 二进制
# ============================================================
if (-not $SkipBuild) {
    Write-Step "构建 release 二进制 (pnpm tauri build --no-bundle)"
    if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
        Write-Ok "未发现 node_modules，先执行 pnpm install ..."
        Push-Location $ProjectRoot
        try { & pnpm install; if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" } }
        finally { Pop-Location }
    }
    Push-Location $ProjectRoot
    try {
        & pnpm tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build 失败 (exit=$LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

$releaseDir = Join-Path $SrcTauri "target\release"
$exePath    = Join-Path $releaseDir $exeNameExe
if (-not (Test-Path $exePath)) {
    Write-Err "找不到构建产物：$exePath"
    Write-Warn "请先运行完整构建，或去掉 -SkipBuild 让脚本自动构建。"
    exit 1
}
Write-Ok "构建产物：$exePath"

# ============================================================
# 4. 组装 MSIX 暂存目录
# ============================================================
Write-Step "组装 MSIX 暂存目录"
$stage = Join-Path $SrcTauri "target\msix-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 4.1 主程序 + 依赖 DLL
Copy-Item $exePath $stage -Force
Get-ChildItem $releaseDir -Filter *.dll -File | ForEach-Object {
    Copy-Item $_.FullName $stage -Force
}
Write-Ok "已拷贝 exe + $((Get-ChildItem $stage -Filter *.dll).Count) 个依赖 DLL"

# 4.2 运行时资源（技能 / 视觉模型 / tokenizer）
$resSrc = Join-Path $SrcTauri "resources"
if (Test-Path $resSrc) {
    Copy-Item $resSrc (Join-Path $stage "resources") -Recurse -Force
    Write-Ok "已拷贝 resources/（技能、视觉模型、tokenizer）"
} else {
    Write-Warn "未找到 src-tauri/resources，跳过"
}

# 4.3 Store 图标 -> assets
$assetsDir = Join-Path $stage "assets"
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
$iconDir = Join-Path $SrcTauri "icons"
foreach ($icon in @(
    "StoreLogo.png", "Square44x44Logo.png", "Square71x71Logo.png",
    "Square150x150Logo.png", "Square310x310Logo.png", "Square89x89Logo.png",
    "Square107x107Logo.png", "Square142x142Logo.png", "Square284x284Logo.png",
    "Square30x30Logo.png")) {
    $src = Join-Path $iconDir $icon
    if (Test-Path $src) { Copy-Item $src (Join-Path $assetsDir $icon) -Force }
}
Write-Ok "已拷贝 Store 图标到 assets/"

# 4.4 框架依赖声明
$depLines = New-Object System.Collections.Generic.List[string]
if ($BundleVcRuntime) {
    # 尝试把 VC143 运行库打进包内（离线自包含）
    $vcDlls = @("vcruntime140.dll", "vcruntime140_1.dll", "vcruntime140_threads.dll",
        "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
        "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll", "concrt140.dll")
    $redistRoots = Get-ChildItem "C:\Program Files\Microsoft Visual Studio\2022" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "VC\Redist\MSVC" } |
        Where-Object { Test-Path $_ }
    $copied = $false
    foreach ($r in $redistRoots) {
        foreach ($vd in (Get-ChildItem $r -Directory | Sort-Object Name -Descending)) {
            $crtDir = Join-Path $vd.FullName "x64\Microsoft.VC143.CRT"
            if (Test-Path $crtDir) {
                foreach ($dll in $vcDlls) {
                    $src = Join-Path $crtDir $dll
                    if (Test-Path $src) { Copy-Item $src $stage -Force }
                }
                $copied = $true
                break
            }
        }
        if ($copied) { break }
    }
    if ($copied) {
        Write-Ok "已将 VC 运行库 DLL 打入包内（离线自包含）"
    } else {
        Write-Warn "未找到 VS2022 VC143 redist，回退为声明 VCLibs 框架依赖"
        $depLines.Add('    <PackageDependency Name="Microsoft.VCLibs.140.00.UWPDesktop" MinVersion="14.0.30704.0" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"/>')
    }
} else {
    # 默认本地测试：依赖系统已装的 VC 运行库 / Evergreen WebView2
    if ($StoreMode) {
        $depLines.Add('    <PackageDependency Name="Microsoft.VCLibs.140.00.UWPDesktop" MinVersion="14.0.30704.0" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"/>')
        if ($IncludeWebView2Dep) {
            $depLines.Add('    <PackageDependency Name="Microsoft.WebView2" MinVersion="1.0.1150.38" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"/>')
            Write-Ok "StoreMode：声明 VCLibs + WebView2 框架依赖（上传商店需配 -MakeMsixUpload 生成 .msixupload）"
        } else {
            Write-Ok "StoreMode：声明 VCLibs 框架依赖；WebView2 使用系统 Evergreen 运行时（未声明依赖）"
        }
    } else {
        Write-Ok "本地模式：依赖系统 VC 运行库与 Evergreen WebView2 运行时"
    }
}
$frameworkDeps = ($depLines -join "`r`n")

# 4.5 生成 AppxManifest.xml
Write-Step "生成 AppxManifest.xml"
$templatePath = Join-Path $PSScriptRoot "msix\AppxManifest.xml.template"
if (-not (Test-Path $templatePath)) { Write-Err "找不到清单模板：$templatePath"; exit 1 }
$manifest = [System.IO.File]::ReadAllText($templatePath, [System.Text.Encoding]::UTF8)
$manifest = $manifest.Replace("{{IDENTITY_NAME}}", $IdentityName)
$manifest = $manifest.Replace("{{PUBLISHER}}", $PublisherName)
$manifest = $manifest.Replace("{{VERSION}}", $Version)
$manifest = $manifest.Replace("{{ARCH}}", $Architecture)
$manifest = $manifest.Replace("{{DISPLAY_NAME}}", $productName)
$manifest = $manifest.Replace("{{PUBLISHER_DISPLAY_NAME}}", $publisher)
$manifest = $manifest.Replace("{{DESCRIPTION}}", $description)
$manifest = $manifest.Replace("{{LANG}}", $Language)
$manifest = $manifest.Replace("{{EXE_NAME}}", $exeNameExe)
$manifest = $manifest.Replace("{{FRAMEWORK_DEPENDENCIES}}", $frameworkDeps)
$manifestPath = Join-Path $stage "AppxManifest.xml"
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "已写入 $manifestPath"

# ============================================================
# 5. MakeAppx 打包
# ============================================================
Write-Step "MakeAppx 打包 MSIX"
$msixName = "{0}_{1}_{2}.msix" -f $productName, $Version, $Architecture
$msixPath = Join-Path $OutDir $msixName
$msixUploadPath = ""   # 若启用 -MakeMsixUpload，签名后生成 .msixupload
& $makeAppx pack /d $stage /p $msixPath /o
if ($LASTEXITCODE -ne 0) {
    Write-Err "MakeAppx 打包失败 (exit=$LASTEXITCODE)"
    exit 1
}
Write-Ok "已生成：$msixPath"

# ============================================================
# 6. 签名
# ============================================================
if ($SkipSign) {
    Write-Warn "已跳过签名 —— 未签名的 .msix 无法安装，仅用于检查。"
} else {
    Write-Step "签名 MSIX"
    $generatedPfx = ""
    if (-not $PfxPath) {
        Write-Ok "未提供证书，自动生成自签名开发证书（$PublisherName）..."
        $cert = New-SelfSignedCertificate `
            -Type Custom `
            -Subject $PublisherName `
            -KeyAlgorithm RSA `
            -KeyLength 2048 `
            -KeyUsage DigitalSignature `
            -KeyExportPolicy Exportable `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
            -NotAfter (Get-Date).AddYears(3)
        $PfxPassword = "virlen-msix-dev"
        $generatedPfx = Join-Path $OutDir "$productName-dev.pfx"
        $secPass = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
        Export-PfxCertificate -Cert $cert -FilePath $generatedPfx -Password $secPass | Out-Null
        $PfxPath = $generatedPfx
        Write-Ok "已导出开发证书：$generatedPfx"
    }

    if (-not (Test-Path $PfxPath)) { Write-Err "找不到证书：$PfxPath"; exit 1 }

    $sigArgs = @("sign", "/fd", "SHA256", "/f", $PfxPath)
    if ($PfxPassword) { $sigArgs += @("/p", $PfxPassword) }
    if (-not $NoTimestamp) { $sigArgs += @("/tr", "http://timestamp.digicert.com", "/td", "SHA256") }
    $sigArgs += $msixPath

    & $signTool $sigArgs
    $sigExit = $LASTEXITCODE
    if ($sigExit -ne 0 -and -not $NoTimestamp) {
        Write-Warn "带时间戳签名失败 (exit=$sigExit)，重试不带时间戳..."
        $sigArgs2 = @("sign", "/fd", "SHA256", "/f", $PfxPath)
        if ($PfxPassword) { $sigArgs2 += @("/p", $PfxPassword) }
        $sigArgs2 += $msixPath
        & $signTool $sigArgs2
        $sigExit = $LASTEXITCODE
    }
    if ($sigExit -ne 0) {
        Write-Err "SignTool 签名失败 (exit=$sigExit)"
        exit 1
    }
    Write-Ok "签名完成。"

    if ($InstallCert) {
        $thumbCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $PfxPassword)
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
        $store.Open("ReadWrite")
        $store.Add($thumbCert)
        $store.Close()
        Write-Ok "已将证书导入 当前用户受信任根证书存储：$($thumbCert.Subject)"
    }
}

# 6.5 生成 .msixupload（微软商店上传文件 = zip：.msix + 签名证书 .cer）
if ($MakeMsixUpload -and -not $SkipSign) {
    Write-Step "生成 .msixupload 上传文件"
    # 注意：.msixupload 内【不要】附带 .cer 证书文件 —— 商店会报错
    # "The file *.cer is not supported. Remove or update this file."
    $uploadDir = Join-Path $SrcTauri "target\msix-upload-stage"
    if (Test-Path $uploadDir) { Remove-Item $uploadDir -Recurse -Force }
    New-Item -ItemType Directory -Path $uploadDir -Force | Out-Null
    Copy-Item $msixPath $uploadDir

    $msixUploadPath = [System.IO.Path]::ChangeExtension($msixPath, ".msixupload")
    if (Test-Path $msixUploadPath) { Remove-Item $msixUploadPath -Force }
    # Compress-Archive 只接受 .zip 扩展名：先打成 zip 再改名为 .msixupload
    $zipTmp = Join-Path $OutDir "$([System.IO.Path]::GetFileNameWithoutExtension($msixPath)).upload.zip"
    if (Test-Path $zipTmp) { Remove-Item $zipTmp -Force }
    Compress-Archive -Path (Join-Path $uploadDir "*") -DestinationPath $zipTmp -CompressionLevel Optimal -Force
    Move-Item $zipTmp $msixUploadPath -Force
    Remove-Item $uploadDir -Recurse -Force
    Write-Ok "已生成：$msixUploadPath（仅含 .msix，不含证书）"
}

# ============================================================
# 7. 完成
# ============================================================
Write-Step "完成"
Write-Ok  "MSIX 包：$msixPath"
Write-Ok  "大小   ：$([math]::Round((Get-Item $msixPath).Length / 1MB, 2)) MB"
if ($SkipSign) {
    Write-Warn "该包未签名，无法直接安装。"
} else {
    Write-Ok ""
    Write-Ok "安装（需开启 开发者模式/旁加载，Windows 设置 -> 隐私和安全性 -> 开发者选项）："
    Write-Ok "  Add-AppxPackage -Path '$msixPath'"
    if (-not $InstallCert) {
        Write-Ok ""
        Write-Ok "若提示'证书不受信任'，请先用 -InstallCert 重跑本脚本，"
        Write-Ok "或把签名证书手动导入到'受信任的根证书颁发机构'。"
    }
}
if ($StoreMode) {
    Write-Ok ""
    Write-Ok "微软商店（Partner Center）上传："
    if ($MakeMsixUpload -and -not $SkipSign -and $msixUploadPath) {
        Write-Ok "  上传文件：$msixUploadPath"
    } else {
        Write-Ok "  上传文件：$msixPath"
    }
    Write-Ok "  清单 Identity  = $IdentityName"
    Write-Ok "  清单 Publisher = $PublisherName"
    Write-Ok "  请在 Partner Center 确认以上两项与你的开发者账号完全一致；"
    Write-Ok "  若报'发布者名称无效'，用 -PublisherName 传入账号 Publisher ID。"
}
