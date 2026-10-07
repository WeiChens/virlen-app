//! macOS 离线语音识别（Apple SFSpeechRecognizer）。
//!
//! 仅 macOS 生效（依赖 `speech` crate v0.5.0）；其他平台保留命令签名并返回错误，不影响构建。
//!
//! 锁定 0.5.0：0.8.x 的 Swift 桥接引用了 macOS 26 SDK 才有的 API，旧 SDK 编译报
//! `extra argument 'weight' in call`；0.5.0 只用 macOS 14+ API，且强制 on-device（离线免 Key）。

/// 请求语音识别授权（幂等：已授权则直接返回）
/// 返回值：authorized / denied / restricted / not-determined
#[tauri::command]
pub fn macos_request_speech_authorization() -> Result<String, String> {
    macos_request_authorization_inner()
}

#[cfg(target_os = "macos")]
fn macos_request_authorization_inner() -> Result<String, String> {
    use speech::prelude::*;
    if SpeechRecognizer::authorization_status().is_authorized() {
        return Ok("authorized".to_string());
    }
    let status = SpeechRecognizer::request_authorization();
    Ok(format!("{:?}", status).to_lowercase())
}

#[cfg(not(target_os = "macos"))]
fn macos_request_authorization_inner() -> Result<String, String> {
    Err("语音识别仅支持 macOS".to_string())
}

/// 识别本地音频文件（支持 AIFF / WAV / M4A / MP3 等 AVFoundation 可读格式），返回识别文本
#[tauri::command]
pub async fn macos_transcribe_speech(path: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || transcribe_macos(&path))
            .await
            .map_err(|e| format!("语音识别任务异常: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("语音识别仅支持 macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
fn transcribe_macos(path: &str) -> Result<String, String> {
    use speech::prelude::*;

    // 1. 授权（首次会弹出系统授权框）
    if !SpeechRecognizer::authorization_status().is_authorized() {
        let status = SpeechRecognizer::request_authorization();
        if !status.is_authorized() {
            return Err(format!("语音识别未授权: {:?}", status));
        }
    }

    // 2. 构造识别器：中文优先（离线 on-device）
    let recognizer = SpeechRecognizer::with_locale("zh-CN");
    if !recognizer.is_available() {
        return Err("zh-CN 语音识别器不可用，请检查系统是否已安装对应语言包".to_string());
    }

    // 3. 同步识别（阻塞，已放入 spawn_blocking）
    let result = recognizer
        .recognize_in_path(path)
        .map_err(|e| format!("语音识别失败: {}", e))?;

    let text = result.transcript.trim().to_string();
    if text.is_empty() {
        return Err("未识别到语音内容".to_string());
    }
    Ok(text)
}
