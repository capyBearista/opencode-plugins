use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateNoticeCache {
    pub checked_at: u64,
    pub notices: Vec<UpdateNotice>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateNotice {
    pub package_name: String,
    pub latest_version: String,
    pub installed_version: Option<String>,
}

pub fn read_update_notice_cache() -> Option<UpdateNoticeCache> {
    read_update_notice_cache_from_path(default_notice_cache_path())
}

pub fn read_update_notice_cache_from_path(path: impl AsRef<Path>) -> Option<UpdateNoticeCache> {
    let content = fs::read_to_string(path).ok()?;
    let cache: UpdateNoticeCache = serde_json::from_str(&content).ok()?;

    if is_fresh(cache.checked_at) {
        Some(cache)
    } else {
        None
    }
}

fn default_notice_cache_path() -> std::path::PathBuf {
    directories::ProjectDirs::from("", "", "oc-plugins")
        .map(|dirs| dirs.cache_dir().join("notice.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("notice.json"))
}

fn is_fresh(checked_at: u64) -> bool {
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => return false,
    };

    now.checked_sub(checked_at)
        .is_some_and(|age| age < 12 * 60 * 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tempfile::tempdir;

    fn unix_secs(time: SystemTime) -> u64 {
        time.duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    #[test]
    fn reads_fresh_update_notice_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");
        let checked_at = unix_secs(SystemTime::now() - Duration::from_secs(60));
        let json = serde_json::json!({
            "checked_at": checked_at,
            "notices": [
                {
                    "package_name": "@scope/plugin-a",
                    "latest_version": "2.0.0",
                    "installed_version": "1.0.0"
                },
                {
                    "package_name": "plugin-b",
                    "latest_version": "3.1.4",
                    "installed_version": null
                }
            ]
        });

        fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

        let cache = read_update_notice_cache_from_path(&path);

        assert!(cache.is_some());
        let cache = cache.unwrap();
        assert_eq!(cache.checked_at, checked_at);
        assert_eq!(cache.notices.len(), 2);
        assert_eq!(cache.notices[0].package_name, "@scope/plugin-a");
        assert_eq!(cache.notices[0].latest_version, "2.0.0");
        assert_eq!(cache.notices[0].installed_version.as_deref(), Some("1.0.0"));
        assert_eq!(cache.notices[1].installed_version, None);
    }

    #[test]
    fn ignores_stale_update_notice_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");
        let checked_at = unix_secs(SystemTime::now() - Duration::from_secs(13 * 60 * 60));
        let json = serde_json::json!({
            "checked_at": checked_at,
            "notices": [
                {
                    "package_name": "plugin-a",
                    "latest_version": "2.0.0",
                    "installed_version": "1.0.0"
                }
            ]
        });

        fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

        assert!(read_update_notice_cache_from_path(&path).is_none());
    }

    #[test]
    fn ignores_missing_or_malformed_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");

        assert!(read_update_notice_cache_from_path(&path).is_none());

        fs::write(&path, "not json").unwrap();

        assert!(read_update_notice_cache_from_path(&path).is_none());
    }
}
