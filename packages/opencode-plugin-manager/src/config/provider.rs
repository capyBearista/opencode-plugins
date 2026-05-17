use crate::errors::CliError;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigScope {
    Project,
    Global,
}

#[derive(Debug, Clone)]
pub struct PluginEntry {
    pub spec: String,
    pub scope: ConfigScope,
    pub config_path: PathBuf,
}

pub trait ConfigProvider {
    #[allow(dead_code)]
    fn scope(&self) -> ConfigScope;
    fn config_paths(&self) -> Result<Vec<PathBuf>, CliError>;
    fn read_plugins(&self) -> Result<Vec<PluginEntry>, CliError>;
}
