use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum CliError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("IO error at {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },

    #[error("Parse error: {detail}")]
    Parse { detail: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Validation error: {0}")]
    Validation(String),
}

#[derive(Serialize)]
pub struct JsonError {
    pub error: String,
    pub message: String,
}

impl CliError {
    pub fn to_json(&self) -> JsonError {
        JsonError {
            error: match self {
                CliError::Config(_) => "CONFIG_ERROR".to_string(),
                CliError::Io { .. } => "IO_ERROR".to_string(),
                CliError::Parse { .. } => "PARSE_ERROR".to_string(),
                CliError::Network(_) => "NETWORK_ERROR".to_string(),
                CliError::NotFound(_) => "NOT_FOUND".to_string(),
                CliError::Validation(_) => "VALIDATION_ERROR".to_string(),
            },
            message: self.to_string(),
        }
    }
}
