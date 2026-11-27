use serde::Deserialize;
use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

use crate::usage::Os;

const NEW_ISSUE: &str = "https://github.com/alaibe/grenier/issues/new";

/// The two forms the app opens: the page can name one, never a URL.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Feedback {
    Problem,
    Feature,
}

/// The public issue form, filled in with Grenier's version and the system's name, and nothing else.
pub fn feedback_url(kind: Feedback, version: &str, os: Os) -> Result<Url, String> {
    let template = match kind {
        Feedback::Problem => "bug_report.yml",
        Feedback::Feature => "feature_request.yml",
    };
    Url::parse_with_params(
        NEW_ISSUE,
        [("template", template), ("version", version), ("platform", os.name())],
    )
    .map_err(|error| error.to_string())
}

/// Opens the issue form in the person's browser.
#[tauri::command]
pub fn open_feedback(app: AppHandle, kind: Feedback) -> Result<(), String> {
    let url = feedback_url(kind, &app.package_info().version.to_string(), Os::current())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_in_only_the_version_and_the_system() {
        let url = feedback_url(Feedback::Problem, "0.1.11", Os::MacOs).unwrap();
        assert_eq!(
            url.as_str(),
            "https://github.com/alaibe/grenier/issues/new?template=bug_report.yml&version=0.1.11&platform=macOS"
        );
        let feature = feedback_url(Feedback::Feature, "1.0.0", Os::Linux).unwrap();
        assert!(feature.as_str().contains("template=feature_request.yml"));
    }

    #[test]
    fn the_page_names_a_form_never_a_url() {
        assert_eq!(
            serde_json::from_str::<Feedback>("\"problem\"").unwrap(),
            Feedback::Problem
        );
        assert!(serde_json::from_str::<Feedback>("\"https://example.com\"").is_err());
    }
}
