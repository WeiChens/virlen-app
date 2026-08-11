//! macOS 离线语音识别（Apple SFSpeechRecognizer）
//!
//! 仅 macOS 生效：依赖 `speech` crate（Swift 桥接 Apple Speech.framework）。
//! 其他平台保留命令签名并返回明确错误，不影响 Windows/Linux 构建。

/// 请求语音识别授权（幂等：已授权则直接返回）
/// 返回值：authorized / denied / restricted / not-determined / unknown
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
    Ok(auth_status_str(status).to_string())
}

#[cfg(not(target_os = "macos"))]
fn macos_request_authorization_inner() -> Result<String, String> {
    Err("语音识别仅支持 macOS".to_string())
}

/// 识别本地音频文件（支持 wav / m4a / aiff / mp3 / flac），返回识别文本
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
            return Err(format!("语音识别未授权: {}", auth_status_str(status)));
        }
    }

    // 2. 构造识别器：中文优先，回退系统默认 locale
    let recognizer = SpeechRecognizer::with_locale("zh-CN")
        .with_default_task_hint(TaskHint::Dictation)
        .with_callback_queue(CallbackQueue::named("virlen-speech"));

    // 3. 先尝试离线 on-device 识别（免网络、免 Key）
    let on_device_request = UrlRecognitionRequest::new(path).with_options(
        RecognitionRequestOptions::new()
            .with_requires_on_device_recognition(true)
            .with_adds_punctuation(true),
    );

    if let Ok(result) = recognizer.recognize_request(&on_device_request) {
        return Ok(extract_transcript(&result));
    }

    // 4. 离线识别不可用（如未下载离线语言包）→ 回退 Apple 服务器识别
    //    （仍需联网，但同样免 API Key；要求 macOS 上已启用 Siri）
    let online_request = UrlRecognitionRequest::new(path).with_options(
        RecognitionRequestOptions::new().with_adds_punctuation(true),
    );
    let result = recognizer
        .recognize_request(&online_request)
        .map_err(|e| format!("语音识别失败(离线/在线均不可用): {}", e))?;

    Ok(extract_transcript(&result))
}

#[cfg(target_os = "macos")]
fn extract_transcript(result: &speech::prelude::DetailedRecognitionResult) -> String {
    let text = result.transcript().trim().to_string();
    if text.is_empty() {
        "".to_string()
    } else {
        text
    }
}

#[cfg(target_os = "macos")]
fn auth_status_str(status: speech::prelude::AuthorizationStatus) -> &'static str {
    match status {
        speech::prelude::AuthorizationStatus::Authorized => "authorized",
        speech::prelude::AuthorizationStatus::Denied => "denied",
        speech::prelude::AuthorizationStatus::Restricted => "restricted",
        speech::prelude::AuthorizationStatus::NotDetermined => "not-determined",
        _ => "unknown",
    }
}
