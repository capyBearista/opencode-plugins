use crate::config::provider::{ConfigProvider, ConfigScope, PluginEntry};
use crate::errors::CliError;
use directories::ProjectDirs;
use jsonc_parser::parse_to_ast;
use std::fs;
use std::path::{Path, PathBuf};

pub struct GlobalConfigProvider;

impl GlobalConfigProvider {
    pub fn new() -> Self {
        Self
    }
}

impl ConfigProvider for GlobalConfigProvider {
    fn scope(&self) -> ConfigScope {
        ConfigScope::Global
    }

    fn config_paths(&self) -> Result<Vec<PathBuf>, CliError> {
        let mut paths = Vec::new();
        if let Some(proj_dirs) = ProjectDirs::from("", "", "opencode") {
            let config_dir = proj_dirs.config_dir();
            paths.push(config_dir.join("opencode.jsonc"));
            paths.push(config_dir.join("opencode.json"));
            paths.push(config_dir.join("config.json"));
        }
        Ok(paths)
    }

    fn read_plugins(&self) -> Result<Vec<PluginEntry>, CliError> {
        let paths = self.config_paths()?;
        let mut plugins = Vec::new();

        for path in paths {
            if path.exists() {
                let content = fs::read_to_string(&path)?;
                let ast = parse_to_ast(&content, &Default::default(), &Default::default())
                    .map_err(|e| {
                        CliError::Parse(format!("Failed to parse {}: {}", path.display(), e))
                    })?;

                if let Some(value) = ast.value {
                    if let jsonc_parser::ast::Value::Object(obj) = value {
                        if let Some(plugin_prop) =
                            obj.properties.iter().find(|p| p.name.as_str() == "plugin")
                        {
                            if let jsonc_parser::ast::Value::Array(arr) = &plugin_prop.value {
                                for element in &arr.elements {
                                    if let jsonc_parser::ast::Value::StringLit(s) = element {
                                        if !s.value.starts_with("/") && !s.value.starts_with("./") && !s.value.starts_with("../") && !s.value.starts_with("file:") { plugins.push(PluginEntry {
                                            spec: s.value.to_string(),
                                            scope: ConfigScope::Global,
                                            config_path: path.clone(),
                                        }); }
                                    }
                                }
                            }
                        }
                    }
                }
                // OpenCode merges configs, but for plugins it concatenates arrays.
                // We should probably read all existing configs and merge them.
            }
        }

        Ok(plugins)
    }
}

pub struct ProjectConfigProvider {
    cwd: PathBuf,
}

impl ProjectConfigProvider {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd }
    }
}

impl ConfigProvider for ProjectConfigProvider {
    fn scope(&self) -> ConfigScope {
        ConfigScope::Project
    }

    fn config_paths(&self) -> Result<Vec<PathBuf>, CliError> {
        let mut paths = Vec::new();
        let mut current = self.cwd.as_path();

        loop {
            let opencode_dir = current.join(".opencode");
            if opencode_dir.exists() && opencode_dir.is_dir() {
                paths.push(opencode_dir.join("opencode.jsonc"));
                paths.push(opencode_dir.join("opencode.json"));
            }

            paths.push(current.join("opencode.jsonc"));
            paths.push(current.join("opencode.json"));

            if let Some(parent) = current.parent() {
                current = parent;
            } else {
                break;
            }
        }

        Ok(paths)
    }

    fn read_plugins(&self) -> Result<Vec<PluginEntry>, CliError> {
        let paths = self.config_paths()?;
        let mut plugins = Vec::new();

        for path in paths {
            if path.exists() {
                let content = fs::read_to_string(&path)?;
                let ast = parse_to_ast(&content, &Default::default(), &Default::default())
                    .map_err(|e| {
                        CliError::Parse(format!("Failed to parse {}: {}", path.display(), e))
                    })?;

                if let Some(value) = ast.value {
                    if let jsonc_parser::ast::Value::Object(obj) = value {
                        if let Some(plugin_prop) =
                            obj.properties.iter().find(|p| p.name.as_str() == "plugin")
                        {
                            if let jsonc_parser::ast::Value::Array(arr) = &plugin_prop.value {
                                for element in &arr.elements {
                                    if let jsonc_parser::ast::Value::StringLit(s) = element {
                                        if !s.value.starts_with("/") && !s.value.starts_with("./") && !s.value.starts_with("../") && !s.value.starts_with("file:") { plugins.push(PluginEntry {
                                            spec: s.value.to_string(),
                                            scope: ConfigScope::Project,
                                            config_path: path.clone(),
                                        }); }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(plugins)
    }
}
