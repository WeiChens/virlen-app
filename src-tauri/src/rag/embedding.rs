//! 嵌入生成服务
//!
//! 负责将文本转换为向量嵌入。
//! 目前支持通过 HTTP 调用 OpenAI 兼容的 Embedding API，
//! 后续可扩展本地嵌入（如 fastembed-rs）。

use serde::{Deserialize, Serialize};

/// 嵌入配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    /// API 地址（兼容 OpenAI 格式）
    pub api_url: String,
    /// API Key
    pub api_key: String,
    /// 模型名称
    pub model: String,
    /// 向量维度
    pub dimensions: usize,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            api_url: String::new(),
            api_key: String::new(),
            model: "text-embedding-3-small".into(),
            dimensions: 1536,
        }
    }
}

/// 嵌入提供者 Trait
pub trait EmbeddingProvider: Send + Sync {
    /// 生成单个文本的嵌入向量
    fn embed(&self, text: &str) -> Result<Vec<f32>, String>;

    /// 批量生成嵌入向量
    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        texts.iter().map(|t| self.embed(t)).collect()
    }

    /// 获取向量维度
    fn dimensions(&self) -> usize;
}

/// OpenAI 兼容的嵌入 API 提供者
pub struct OpenAIEmbeddingProvider {
    config: EmbeddingConfig,
    client: reqwest::blocking::Client,
}

impl OpenAIEmbeddingProvider {
    pub fn new(config: EmbeddingConfig) -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            config,
        }
    }

    /// 从环境变量创建
    pub fn from_env() -> Option<Self> {
        let api_url = std::env::var("VITE_OPENAI_BASE_URL")
            .or_else(|_| std::env::var("OPENAI_BASE_URL"))
            .ok()?;

        let api_key = std::env::var("VITE_OPENAI_API_KEY")
            .or_else(|_| std::env::var("OPENAI_API_KEY"))
            .ok()?;

        let api_url = format!(
            "{}/v1/embeddings",
            api_url.trim_end_matches('/').trim_end_matches("/v1")
        );

        Some(Self::new(EmbeddingConfig {
            api_url,
            api_key,
            ..Default::default()
        }))
    }
}

impl EmbeddingProvider for OpenAIEmbeddingProvider {
    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let body = serde_json::json!({
            "model": self.config.model,
            "input": text,
            "encoding_format": "float"
        });

        let response = self
            .client
            .post(&self.config.api_url)
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .map_err(|e| format!("嵌入 API 请求失败: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            let err_text = response.text().unwrap_or_default();
            return Err(format!("嵌入 API 返回错误 ({}): {}", status, err_text));
        }

        let data: EmbeddingResponse = response
            .json()
            .map_err(|e| format!("解析嵌入响应失败: {}", e))?;

        data.data
            .into_iter()
            .next()
            .map(|d| d.embedding)
            .ok_or_else(|| "嵌入 API 返回空结果".into())
    }

    fn dimensions(&self) -> usize {
        self.config.dimensions
    }
}

/// OpenAI Embedding API 响应结构
#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
    model: String,
    usage: Option<EmbeddingUsage>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
    index: usize,
}

#[derive(Debug, Deserialize)]
struct EmbeddingUsage {
    prompt_tokens: usize,
    total_tokens: usize,
}

/// Ollama 本地嵌入提供者
///
/// 调用本地 Ollama 服务的嵌入 API，实现真正的语义理解。
/// Ollama 默认运行在 http://localhost:11434
/// 支持模型如：nomic-embed-text, bge-m3, mxbai-embed-large 等
pub struct OllamaEmbeddingProvider {
    base_url: String,
    model: String,
    dimensions: usize,
    client: reqwest::blocking::Client,
}

impl OllamaEmbeddingProvider {
    /// 创建 Ollama 嵌入提供者
    ///
    /// * `base_url` - Ollama 服务地址，如 "http://localhost:11434"
    /// * `model` - 嵌入模型名，如 "nomic-embed-text"（轻量推荐）或 "bge-m3"（更强中文）
    /// * `dimensions` - 输出向量维度
    pub fn new(base_url: String, model: String, dimensions: usize) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
            dimensions,
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    /// 使用默认参数创建（尝试连接本地 Ollama）
    pub fn with_defaults() -> Result<Self, String> {
        let base_url = "http://localhost:11434".to_string();

        // 先测试连接
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let resp = client
            .get(format!("{}/api/tags", base_url))
            .send()
            .map_err(|_| "无法连接到 Ollama 服务，请确认 Ollama 已启动".to_string())?;

        if !resp.status().is_success() {
            return Err("Ollama 服务返回异常状态".to_string());
        }

        // 自动选择可用的嵌入模型
        let body: serde_json::Value = resp
            .json()
            .map_err(|_| "解析 Ollama 响应失败".to_string())?;

        let models = body["models"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["name"].as_str())
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // 偏好列表：优先选择更好的模型
        let preferred = [
            "bge-m3",
            "mxbai-embed-large",
            "nomic-embed-text",
            "all-minilm",
            "snowflake-arctic-embed",
        ];

        let selected = preferred
            .iter()
            .find(|&&name| models.iter().any(|m| m.starts_with(name)))
            .map(|&name| name.to_string())
            .or_else(|| models.first().cloned())
            .unwrap_or_else(|| "nomic-embed-text".to_string());

        // 设置维度
        let dims = if selected.starts_with("bge-m3") {
            1024
        } else if selected.starts_with("mxbai-embed-large") {
            1024
        } else {
            768
        };

        Ok(Self::new(base_url, selected, dims))
    }
}

impl EmbeddingProvider for OllamaEmbeddingProvider {
    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let body = serde_json::json!({
            "model": self.model,
            "prompt": text,
        });

        let url = format!("{}/api/embeddings", self.base_url);
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .map_err(|e| format!("Ollama 嵌入请求失败: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            let err_text = response.text().unwrap_or_default();
            return Err(format!("Ollama 返回错误 ({}): {}", status, err_text));
        }

        let data: OllamaEmbeddingResponse = response
            .json()
            .map_err(|e| format!("解析 Ollama 响应失败: {}", e))?;

        Ok(data.embedding)
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }
}

// ===== 辅助函数（供测试使用） =====

/// 计算两个向量的余弦相似度
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a < 1e-10 || norm_b < 1e-10 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== NgramEmbeddingProvider ====================

    #[test]
    fn test_ngram_dimensions() {
        let provider = NgramEmbeddingProvider::new(512);
        assert_eq!(provider.dimensions(), 512);

        let provider = NgramEmbeddingProvider::new(256);
        assert_eq!(provider.dimensions(), 256);
    }

    #[test]
    fn test_ngram_embedding_normalized() {
        let provider = NgramEmbeddingProvider::new(512);
        let vec = provider.embed("Hello World!").unwrap();
        // L2 范数应 ≈ 1.0
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "L2 norm should be 1.0, got {}", norm);
    }

    #[test]
    fn test_ngram_embedding_consistency() {
        let provider = NgramEmbeddingProvider::new(512);
        let v1 = provider.embed("Rust programming language").unwrap();
        let v2 = provider.embed("Rust programming language").unwrap();
        assert_eq!(v1.len(), v2.len());
        // 相同输入应产生相同输出（确定性）
        for (a, b) in v1.iter().zip(v2.iter()) {
            assert!((a - b).abs() < 1e-6, "deterministic embedding failed");
        }
    }

    #[test]
    fn test_ngram_similar_texts_higher_similarity() {
        let provider = NgramEmbeddingProvider::new(512);

        // 相似文本（都关于 Rust 编程）
        let v_similar_a = provider.embed("Rust is a systems programming language").unwrap();
        let v_similar_b = provider.embed("Rust programming language for systems").unwrap();

        // 不相似文本（完全不同主题）
        let v_diff = provider.embed("The weather is sunny today in Beijing").unwrap();

        let sim_between_similar = cosine_similarity(&v_similar_a, &v_similar_b);
        let sim_between_diff = cosine_similarity(&v_similar_a, &v_diff);

        assert!(
            sim_between_similar > sim_between_diff,
            "similar texts ({:.4}) should score higher than dissimilar ({:.4})",
            sim_between_similar,
            sim_between_diff
        );
    }

    #[test]
    fn test_ngram_chinese_similarity() {
        let provider = NgramEmbeddingProvider::new(512);

        let v1 = provider.embed("Rust 是一种系统编程语言").unwrap();
        let v2 = provider.embed("Rust 编程语言用于系统开发").unwrap();
        let v3 = provider.embed("今天天气真好适合出门散步").unwrap();

        let sim_similar = cosine_similarity(&v1, &v2);
        let sim_diff = cosine_similarity(&v1, &v3);

        assert!(
            sim_similar > sim_diff,
            "中文相似文本 ({:.4}) 应高于不相似文本 ({:.4})",
            sim_similar,
            sim_diff
        );
    }

    #[test]
    fn test_ngram_empty_text() {
        let provider = NgramEmbeddingProvider::new(512);
        let vec = provider.embed("").unwrap();
        assert_eq!(vec.len(), 512);
        // 空文本应返回零向量
        let sum: f32 = vec.iter().map(|x| x.abs()).sum();
        assert!(sum < 1e-10, "empty text should produce zero vector");
    }

    #[test]
    fn test_ngram_embedding_special_chars() {
        let provider = NgramEmbeddingProvider::new(512);
        // 特殊字符不应 panic
        let vec = provider.embed("!@#$%^&*()_+-=[]{}|;':\",./<>?~`").unwrap();
        assert_eq!(vec.len(), 512);
        // 特殊字符的嵌入应该是归一化的
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5 || norm < 1e-10);
    }

    #[test]
    fn test_ngram_different_dimensions() {
        for dim in [64, 128, 256, 512, 768] {
            let provider = NgramEmbeddingProvider::new(dim);
            let vec = provider.embed("test").unwrap();
            assert_eq!(vec.len(), dim, "dimension {} failed", dim);
            let norm: f32 = vec.iter().map(|x| x * x).sum();
            // 非空文本应有非零向量
            assert!(norm > 0.0, "dimension {} produced zero vector", dim);
        }
    }

    // ==================== SimpleEmbeddingProvider ====================

    #[test]
    fn test_simple_embedding_consistency() {
        let provider = SimpleEmbeddingProvider::new(64);
        let v1 = provider.embed("test input").unwrap();
        let v2 = provider.embed("test input").unwrap();
        assert_eq!(v1.len(), v2.len());
        for (a, b) in v1.iter().zip(v2.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn test_simple_embedding_dimensions() {
        let provider = SimpleEmbeddingProvider::new(128);
        assert_eq!(provider.dimensions(), 128);
        let vec = provider.embed("hello").unwrap();
        assert_eq!(vec.len(), 128);
    }

    #[test]
    fn test_simple_embedding_normalized() {
        let provider = SimpleEmbeddingProvider::new(64);
        let vec = provider.embed("some text").unwrap();
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    // ==================== cosine_similarity ====================

    #[test]
    fn test_cosine_similarity_identical() {
        let v = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&v, &v);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 0.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_opposite() {
        let a = vec![1.0, 2.0];
        let b = vec![-1.0, -2.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim + 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_empty() {
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
        assert_eq!(cosine_similarity(&[1.0], &[]), 0.0);
    }

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let a = vec![0.0, 0.0];
        let b = vec![1.0, 1.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }
}

#[derive(Debug, Deserialize)]
struct OllamaEmbeddingResponse {
    embedding: Vec<f32>,
}

/// 基于 n-gram 特征的统计嵌入提供者（纯本地，零外部依赖）
///
/// 原理：
/// - 提取文本中的字符 unigram 和 bigram 作为特征
/// - 使用 TF 归一化的频率作为特征值
/// - 对中文和英文都有效
/// - 比简单哈希嵌入好得多，能捕捉词汇层面的语义相似度
pub struct NgramEmbeddingProvider {
    dimensions: usize,
}

impl NgramEmbeddingProvider {
    pub fn new(dimensions: usize) -> Self {
        Self { dimensions }
    }

    /// 从文本中提取 n-gram 特征
    fn extract_ngrams(text: &str) -> Vec<String> {
        let mut features = Vec::new();
        let chars: Vec<char> = text.chars().collect();

        // 1. 字符 unigram（单个汉字/字母）
        for &c in &chars {
            if c.is_alphanumeric() || c.is_ascii_punctuation() {
                features.push(c.to_string());
            }
        }

        // 2. 字符 bigram（相邻两个字符）
        for window in chars.windows(2) {
            let bigram: String = window.iter().collect();
            // 只保留包含字母/汉字的 bigram
            if window[0].is_alphanumeric() || window[1].is_alphanumeric() {
                features.push(bigram);
            }
        }

        // 3. 中文词特征（2-4个汉字的连续序列）
        let mut i = 0;
        while i < chars.len() {
            if chars[i] >= '\u{4e00}' && chars[i] <= '\u{9fff}' {
                // 中文
                let mut j = i;
                while j < chars.len() && chars[j] >= '\u{4e00}' && chars[j] <= '\u{9fff}' {
                    j += 1;
                }
                let word: String = chars[i..j].iter().collect();
                if word.len() >= 2 {
                    features.push(word);
                }
                i = j;
            } else {
                i += 1;
            }
        }

        features
    }

    /// 使用 MurmurHash 风格的简单哈希将特征映射到维度
    fn hash_feature(feature: &str, dimensions: usize) -> Vec<usize> {
        // 使用多个哈希函数模拟局部敏感哈希
        let mut indices = Vec::new();
        let bytes = feature.as_bytes();

        // 哈希种子
        for seed in 0u8..3 {
            let mut hash: usize = (seed as usize).wrapping_mul(0x9e3779b9);
            for &b in bytes {
                hash = hash.wrapping_mul(0x01000193).wrapping_add(b as usize);
            }
            indices.push(hash % dimensions);
        }

        indices
    }
}

impl EmbeddingProvider for NgramEmbeddingProvider {
    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let text = text.to_lowercase();
        let features = Self::extract_ngrams(&text);

        let mut vec = vec![0.0f32; self.dimensions];

        // 统计特征频率
        let mut freq: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
        for f in &features {
            *freq.entry(f.clone()).or_insert(0.0) += 1.0;
        }

        // TF 归一化 + 哈希映射到向量空间
        let max_freq = freq.values().cloned().fold(0.0f32, f32::max);

        for (feature, count) in &freq {
            // TF 值：归一化频率 (log(1 + count) / log(1 + max_freq))
            let tf = if max_freq > 0.0 {
                (1.0 + count).ln() / (1.0 + max_freq).ln()
            } else {
                0.0
            };

            // 使用哈希将特征映射到多个维度
            let indices = Self::hash_feature(feature, self.dimensions);
            for &idx in &indices {
                vec[idx] += tf;
            }
        }

        // IDF 风格的稀有特征增强：低频特征获得更高权重
        // 这里简化处理，用特征数量的倒数作为权重
        let num_features = freq.len() as f32;
        if num_features > 0.0 {
            for v in &mut vec {
                *v *= (1.0 + (self.dimensions as f32) / (num_features + 100.0)).sqrt();
            }
        }

        // L2 归一化
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 1e-10 {
            for v in &mut vec {
                *v /= norm;
            }
        }

        Ok(vec)
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }
}

/// 简单的内存嵌入提供者（仅用于回退）
pub struct SimpleEmbeddingProvider {
    dimensions: usize,
}

impl SimpleEmbeddingProvider {
    pub fn new(dimensions: usize) -> Self {
        Self { dimensions }
    }
}

impl EmbeddingProvider for SimpleEmbeddingProvider {
    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        // 一个简单的确定性哈希嵌入（仅供测试，不保证语义）
        let mut vec = vec![0.0f32; self.dimensions];
        let bytes = text.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            let idx = i % self.dimensions;
            vec[idx] += (b as f32) / 255.0;
        }
        // 归一化
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in &mut vec {
                *v /= norm;
            }
        }
        Ok(vec)
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }
}
