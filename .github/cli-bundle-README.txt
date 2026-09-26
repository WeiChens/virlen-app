Virlen CLI（headless）—— 解压即用包
====================================

本目录内容
  virlen-cli(.exe)      命令行主程序。无界面；与桌面端**共用同一份**配置与会话库。
  quasivision_models/   端侧视觉模型（vision_analyze 工具用它做 UI 检测 / OCR / 物体检测 /
                        图标识别）。纯本地推理，**图片不出本机**，无需联网即可分析。
  DirectML.dll          [仅 Windows] ONNX Runtime 的 DirectML 执行提供器（GPU 加速）。
                        必须与本 exe 同目录。Windows 自带的 System32\DirectML.dll 版本太旧
                        （1.0），缺本文件时视觉可能无法初始化。
  README.txt            本说明。

快速开始
  ./virlen-cli help                         查看全部命令与选项
  ./virlen-cli chat                         交互式会话（内联视口 TUI；非终端环境自动降级）
  ./virlen-cli run "帮我看看这张截图"          无界面跑一次 agent
  ./virlen-cli list-session --limit 5       列出会话（含上下文占用与条数）
  ./virlen-cli config get                   读取配置（与桌面端同一份）
  库文件位置：<平台数据根>/JianWeichen.virlen/virlen.db（与桌面端同一个库）。
  可用 VIRLEN_DATA_DIR 覆盖数据目录。

视觉模型的查找顺序（按优先级，首个命中者生效）
  1. 编译期资源根（只有开发机构建的产物才可能命中）
  2. $VIRLEN_RESOURCE_DIR
  3. <本 exe 所在目录>/resources
  4. <本 exe 所在目录>
  每一档下面找 quasivision_models/ocr-models/ppocrv5_mobile_det.onnx。
  本包按第 4 档布置（quasivision_models/ 与 exe 同级）→ 解压后直接可用。
  想把模型放到别处：设 VIRLEN_RESOURCE_DIR 指向「quasivision_models 的父目录」即可。

平台提示
  Windows：请保持 exe 与 DirectML.dll 同目录；若杀毒软件误报，放行该目录。
  macOS：  若解压后不能执行，chmod +x virlen-cli；若被 Gatekeeper 拦下，
           xattr -d com.apple.quarantine virlen-cli
  Linux：  若解压工具丢了可执行位，chmod +x virlen-cli

模型文件与镜像
  本包已含全部 7 个模型文件，正常无需联网。也可从桌面端安装目录的
  resources/quasivision_models 拷贝一份。
  若缺模型（至少需手工提供 ppocrv5_mobile_det.onnx，否则程序会直接报
  「quasivision models directory not found.」），程序会尝试联网下载其余缺失文件；
  国内可指向镜像：
    QUASIVISION_MODELS_URL=https://hf-mirror.com/chenjian-wei/quasivision-models/resolve/main
