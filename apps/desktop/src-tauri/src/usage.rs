//! Usage page views to Umami; the core, from the `use` lines to `now_seconds`, is shared with Kestrel and Statim.

use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const ENDPOINT: &str = "https://stats.laibe.cc/api/send";
const WEBSITE: &str = "8703a1e3-cc65-40ba-b060-558c647c959f";
const HOSTNAME: &str = "grenier-app.laibe.cc";
const APP_NAME: &str = "Grenier";
const LANGUAGE: &str = "en-US";
const IP: &str = "127.0.0.1";
const DEVICE: &str = "desktop";
/// 365 days: never more than 12 months, inside the 13 months CNIL lets an audience-measurement tracker live without consent.
const ID_LIFETIME_SECONDS: u64 = 31_536_000;
const TIMEOUT_SECONDS: u64 = 5;
const MAX_BROWSER: usize = 20;
const MAX_SCREEN: usize = 11;
pub const STORE_FILE: &str = "usage.json";
const OFF_TEXT: &str = r#"{"off":true}"#;

macro_rules! screens {
    ($($screen:ident => $url:literal, $title:literal;)*) => {
        /// Every screen a page view can name. The page passes its url, and any other text fails to deserialise.
        #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
        pub enum Screen {
            $(#[serde(rename = $url)] $screen,)*
        }

        impl Screen {
            #[cfg(test)]
            pub const ALL: &'static [Screen] = &[$(Screen::$screen),*];

            pub fn url(self) -> &'static str {
                match self {
                    $(Screen::$screen => $url,)*
                }
            }

            pub fn title(self) -> &'static str {
                match self {
                    $(Screen::$screen => $title,)*
                }
            }
        }
    };
}

// The app's views, as `src/usage/screens.ts` lists them.
screens! {
    Cost => "/cost", "Cost";
    Knowledge => "/knowledge", "Knowledge";
    Routines => "/routines", "Routines";
    Skills => "/skills", "Skills";
    Settings => "/settings", "Settings";
}

/// All the page sends with a page view.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageViewArgs {
    pub screen: Screen,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum Os {
    MacOs,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Os::MacOs => "macOS",
            Os::Windows => "Windows",
            Os::Linux => "Linux",
        }
    }

    /// A plain browser's, the same in every version and app: Umami hashes it into the session, and drops as a bot one
    /// that names the app.
    pub fn user_agent(self) -> &'static str {
        match self {
            Os::MacOs => {
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
            }
            Os::Windows => {
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
            Os::Linux => "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        }
    }
}

/// What the store holds. Missing is on with no id yet; damaged counts as off.
#[derive(Debug, PartialEq, Eq)]
pub enum Stored {
    Missing,
    Off,
    Damaged,
    Id { id: String, made: u64 },
}

/// Off is checked first, so it wins over an id. An id needs 32 lowercase hex characters and a whole `made` of 0 or more.
pub fn parse_store(text: Option<&str>) -> Stored {
    let Some(text) = text else {
        return Stored::Missing;
    };
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(text) else {
        return Stored::Damaged;
    };
    if fields.get("off") == Some(&Value::Bool(true)) {
        return Stored::Off;
    }
    match (
        fields.get("id").and_then(Value::as_str),
        fields.get("made").and_then(Value::as_u64),
    ) {
        (Some(id), Some(made))
            if id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Stored::Id {
                id: id.to_string(),
                made,
            }
        }
        _ => Stored::Damaged,
    }
}

pub fn id_text(id: &str, made: u64) -> String {
    format!(r#"{{"id":"{id}","made":{made}}}"#)
}

pub fn needs_new_id(made: u64, now: u64) -> bool {
    made > now || now - made >= ID_LIFETIME_SECONDS
}

/// The UTC month of a moment in Unix seconds, as YYYY-MM: Umami's own salt turns over at the same instant. Howard
/// Hinnant's civil_from_days.
pub fn month(now: u64) -> String {
    let z = (now / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}")
}

/// The id Umami counts a visitor by: it changes each month, so months of one install cannot be joined.
pub fn visitor_id(install: &str, now: u64) -> String {
    hex(&Sha256::digest(format!("{install}:{}", month(now)))[..16])
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn browser(version: &str) -> String {
    format!("{APP_NAME} {version}").chars().take(MAX_BROWSER).collect()
}

pub fn screen_size(width: u32, height: u32) -> Option<String> {
    let size = format!("{width}x{height}");
    (width > 0 && height > 0 && size.len() <= MAX_SCREEN).then_some(size)
}

pub fn payload(screen: Screen, visitor: &str, version: &str, os: Os, size: Option<String>) -> Value {
    let mut payload = json!({
        "website": WEBSITE,
        "hostname": HOSTNAME,
        "url": screen.url(),
        "title": screen.title(),
        "id": visitor,
        "ip": IP,
        "tag": version,
        "browser": browser(version),
        "os": os.name(),
        "device": DEVICE,
        "language": LANGUAGE,
    });
    if let Some(size) = size {
        payload["screen"] = Value::String(size);
    }
    json!({ "type": "event", "payload": payload })
}

/// The file that holds the install id or the off choice. Without one no id can be kept, so nothing is sent.
pub struct Store {
    file: Option<PathBuf>,
}

impl Store {
    pub fn new(file: Option<PathBuf>) -> Store {
        Store { file }
    }

    fn read(&self) -> std::io::Result<Option<String>> {
        let Some(file) = &self.file else {
            return Ok(None);
        };
        match std::fs::read_to_string(file) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write(&self, text: &str) -> std::io::Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| std::io::Error::new(ErrorKind::Unsupported, "no usage store"))?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, text)
    }

    fn remove(&self) -> std::io::Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        match std::fs::remove_file(file) {
            Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

pub struct Usage {
    store: Store,
    sends: bool,
    os: Os,
    version: String,
    /// Held from reading the store to writing it.
    lock: Mutex<()>,
}

impl Usage {
    pub fn new(store: Store, sends: bool, os: Os, version: String) -> Usage {
        Usage {
            store,
            sends,
            os,
            version,
            lock: Mutex::new(()),
        }
    }

    fn stored(&self) -> Stored {
        match self.store.read() {
            Ok(text) => parse_store(text.as_deref()),
            Err(_) => Stored::Damaged,
        }
    }

    pub fn is_enabled(&self) -> bool {
        let _held = self.lock.lock();
        matches!(self.stored(), Stored::Missing | Stored::Id { .. })
    }

    /// Off writes `OFF_TEXT` at once, which deletes the id and its date. On removes an off or damaged store and leaves
    /// an id alone; the next hit makes a new one.
    pub fn set_enabled(&self, on: bool) -> Result<(), String> {
        let _held = self.lock.lock().map_err(|error| error.to_string())?;
        let done = if !on {
            self.store.write(OFF_TEXT)
        } else if matches!(self.stored(), Stored::Off | Stored::Damaged) {
            self.store.remove()
        } else {
            Ok(())
        };
        done.map_err(|error| error.to_string())
    }

    /// The hit for a screen, or none: in a debug build, when off or damaged, or when a new id can't be kept, since
    /// sending then would count a new visitor every time.
    pub fn page_view(&self, screen: Screen, width: u32, height: u32, now: u64) -> Option<Value> {
        if !self.sends {
            return None;
        }
        let _held = self.lock.lock().ok()?;
        let id = match self.stored() {
            Stored::Off | Stored::Damaged => return None,
            Stored::Id { id, made } if !needs_new_id(made, now) => id,
            Stored::Missing | Stored::Id { .. } => {
                let id = new_install_id()?;
                self.store.write(&id_text(&id, now)).ok()?;
                id
            }
        };
        Some(payload(
            screen,
            &visitor_id(&id, now),
            &self.version,
            self.os,
            screen_size(width, height),
        ))
    }
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

// The shell: Grenier's random source, its HTTP client and its Tauri commands.

use std::time::Duration;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

fn new_install_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(hex(&bytes))
}

/// The updater installs rustls' crypto provider only when it first checks, a minute after launch.
fn client(agent: &str) -> reqwest::Result<reqwest::Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(agent)
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .build()
}

pub async fn post(endpoint: &str, agent: &str, body: &Value) -> reqwest::Result<()> {
    client(agent)?.post(endpoint).json(body).send().await?;
    Ok(())
}

/// The page's `{ screen, width, height }`, read whole so that any other field is refused; fire and forget.
#[tauri::command(async)]
pub fn usage_page_view(request: Request<'_>, usage: State<'_, Usage>) -> Result<(), String> {
    let InvokeBody::Json(args) = request.body() else {
        return Err("a page view takes JSON".into());
    };
    let args: PageViewArgs = serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
    if let Some(body) = usage.page_view(args.screen, args.width, args.height, now_seconds()) {
        let agent = usage.os.user_agent();
        tauri::async_runtime::spawn(async move {
            let _ = post(ENDPOINT, agent, &body).await;
        });
    }
    Ok(())
}

#[tauri::command(async)]
pub fn usage_enabled(usage: State<'_, Usage>) -> bool {
    usage.is_enabled()
}

#[tauri::command(async)]
pub fn usage_set_enabled(enabled: bool, usage: State<'_, Usage>) -> Result<(), String> {
    usage.set_enabled(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::path::Path;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("usage-vectors.json")).unwrap()
    }

    fn rows(name: &str) -> Vec<Value> {
        vectors()[name].as_array().unwrap().clone()
    }

    fn number(value: &Value) -> u64 {
        value.as_u64().unwrap()
    }

    /// The fixture's page view input: the moment, the version and the display.
    fn input() -> (u64, String, u32, u32) {
        let input = &vectors()["payload"]["input"];
        let size = |key: &str| u32::try_from(number(&input[key])).unwrap();
        (
            number(&input["at"]),
            input["version"].as_str().unwrap().to_string(),
            size("width"),
            size("height"),
        )
    }

    /// A store file in a folder of its own, which doesn't exist yet.
    fn store_file(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("grenier-usage-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(STORE_FILE)
    }

    fn usage(file: &Path, sends: bool) -> Usage {
        Usage::new(Store::new(Some(file.to_path_buf())), sends, Os::MacOs, input().1)
    }

    fn text(file: &Path) -> Option<String> {
        std::fs::read_to_string(file).ok()
    }

    fn put(file: &Path, text: &str) {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn stored_id(file: &Path) -> (String, u64) {
        match parse_store(text(file).as_deref()) {
            Stored::Id { id, made } => (id, made),
            other => panic!("{other:?}"),
        }
    }

    fn is_lowercase_hex(text: &str) -> bool {
        text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    }

    #[test]
    fn u01_visitor_id_matches_the_vectors() {
        for row in rows("visitor") {
            let at = number(&row["at"]);
            assert_eq!(month(at), row["month"], "{}", row["utc"]);
            let visitor = visitor_id(row["install"].as_str().unwrap(), at);
            assert_eq!(visitor, row["visitor"], "{}", row["utc"]);
            assert!(visitor.len() == 32 && is_lowercase_hex(&visitor));
        }
    }

    #[test]
    fn u02_id_lifetime_matches_the_vectors() {
        assert_eq!(ID_LIFETIME_SECONDS, vectors()["idLifetimeSeconds"]);
        for row in rows("lifetime") {
            assert_eq!(
                needs_new_id(number(&row["made"]), number(&row["now"])),
                row["replace"],
                "{}",
                row["case"]
            );
        }
    }

    #[test]
    fn u03_store_text_parses_as_the_vectors_say() {
        for row in rows("store") {
            let expected = match row["state"].as_str().unwrap() {
                "missing" => Stored::Missing,
                "off" => Stored::Off,
                "damaged" => Stored::Damaged,
                "id" => Stored::Id {
                    id: row["id"].as_str().unwrap().to_string(),
                    made: number(&row["made"]),
                },
                other => panic!("{other}"),
            };
            assert_eq!(parse_store(row["text"].as_str()), expected, "{}", row["case"]);
        }
    }

    #[test]
    fn u04_store_texts_are_exact() {
        let vectors = vectors();
        let id_case = &vectors["idText"];
        assert_eq!(
            id_text(id_case["id"].as_str().unwrap(), number(&id_case["made"])),
            id_case["text"]
        );
        assert_eq!(OFF_TEXT, vectors["offText"]);
    }

    #[test]
    fn u05_payload_matches_this_apps_vector() {
        let vectors = vectors();
        let input = &vectors["payload"]["input"];
        let app = &vectors["payload"]["apps"]["grenier"];
        assert_eq!(
            (APP_NAME, WEBSITE, HOSTNAME),
            (
                app["name"].as_str().unwrap(),
                app["website"].as_str().unwrap(),
                app["hostname"].as_str().unwrap()
            )
        );
        assert_eq!(
            (Os::MacOs.name(), DEVICE),
            (input["os"].as_str().unwrap(), input["device"].as_str().unwrap())
        );
        let screen: Screen = serde_json::from_value(input["url"].clone()).unwrap();
        assert_eq!(screen.title(), input["title"]);
        let (at, version, width, height) = self::input();
        let visitor = visitor_id(input["install"].as_str().unwrap(), at);

        let body = payload(screen, &visitor, &version, Os::MacOs, screen_size(width, height));
        assert_eq!(body, app["expected"]);
        for key in ["name", "referrer", "timestamp"] {
            assert!(body["payload"].get(key).is_none(), "{key}");
        }
        let mut without_screen = app["expected"].clone();
        without_screen["payload"].as_object_mut().unwrap().remove("screen");
        assert_eq!(payload(screen, &visitor, &version, Os::MacOs, None), without_screen);
    }

    #[test]
    fn u06_browser_screen_and_device_cuts() {
        let vectors = vectors();
        assert_eq!(
            (MAX_BROWSER as u64, MAX_SCREEN as u64),
            (number(&vectors["maxBrowser"]), number(&vectors["maxScreen"]))
        );
        let ours: Vec<Value> = rows("browser")
            .into_iter()
            .filter(|row| row["app"] == APP_NAME)
            .collect();
        assert!(!ours.is_empty());
        for row in ours {
            assert_eq!(browser(row["version"].as_str().unwrap()), row["browser"]);
        }
        for row in rows("screen") {
            let size = |key: &str| u32::try_from(number(&row[key])).unwrap();
            assert_eq!(
                screen_size(size("width"), size("height")).as_deref(),
                row["screen"].as_str(),
                "{row}"
            );
        }
    }

    #[test]
    fn u07_user_agents_match_the_table() {
        let table = &vectors()["userAgent"];
        for os in [Os::MacOs, Os::Windows, Os::Linux] {
            assert_eq!(os.user_agent(), table[os.name()], "{}", os.name());
            let agent = os.user_agent().to_lowercase();
            for name in ["kestrel", "grenier", "statim", "okhttp"] {
                assert!(!agent.contains(name), "{} names {name}", os.name());
            }
        }
    }

    #[test]
    fn u08_debug_build_sends_nothing() {
        let file = store_file("u08");
        let (at, _, width, height) = input();
        let usage = usage(&file, false);
        assert!(usage.is_enabled());
        assert_eq!(usage.page_view(Screen::Settings, width, height, at), None);
        assert!(!file.exists());
    }

    #[test]
    fn u09_first_hit_makes_and_keeps_one_id() {
        let file = store_file("u09");
        let (at, _, width, height) = input();
        let first = usage(&file, true);
        let body = first.page_view(Screen::Settings, width, height, at).unwrap();
        let (id, made) = stored_id(&file);
        assert_eq!(made, at);
        assert_eq!(text(&file).unwrap(), id_text(&id, at));
        assert_eq!(body["payload"]["id"], visitor_id(&id, at));

        let again = first.page_view(Screen::Cost, width, height, at + 60).unwrap();
        assert_eq!(again["payload"]["id"], body["payload"]["id"]);
        let relaunched = usage(&file, true)
            .page_view(Screen::Settings, width, height, at + 120)
            .unwrap();
        assert_eq!(relaunched["payload"]["id"], body["payload"]["id"]);
        assert_eq!(text(&file).unwrap(), id_text(&id, at));
    }

    #[test]
    fn u10_old_or_future_id_is_replaced_before_the_hit() {
        let old = vectors()["idText"]["id"].as_str().unwrap().to_string();
        let (_, _, width, height) = input();
        for (case, row) in rows("lifetime").into_iter().enumerate() {
            let file = store_file(&format!("u10-{case}"));
            let (made, now) = (number(&row["made"]), number(&row["now"]));
            put(&file, &id_text(&old, made));
            let body = usage(&file, true)
                .page_view(Screen::Settings, width, height, now)
                .unwrap();
            if row["replace"] == true {
                let (id, stamped) = stored_id(&file);
                assert_ne!(id, old, "{}", row["case"]);
                assert_eq!(stamped, now, "{}", row["case"]);
                assert_eq!(body["payload"]["id"], visitor_id(&id, now), "{}", row["case"]);
            } else {
                assert_eq!(text(&file).unwrap(), id_text(&old, made), "{}", row["case"]);
                assert_eq!(body["payload"]["id"], visitor_id(&old, now), "{}", row["case"]);
            }
        }
    }

    #[test]
    fn u11_off_sends_nothing_and_deletes_the_id() {
        let file = store_file("u11");
        let (at, _, width, height) = input();
        let usage = usage(&file, true);
        usage.page_view(Screen::Settings, width, height, at).unwrap();
        let (id, _) = stored_id(&file);
        usage.set_enabled(false).unwrap();
        assert_eq!(text(&file).unwrap(), OFF_TEXT);
        assert!(!text(&file).unwrap().contains(&id));
        assert!(!usage.is_enabled());
        assert_eq!(usage.page_view(Screen::Settings, width, height, at), None);
        assert_eq!(text(&file).unwrap(), OFF_TEXT);
    }

    #[test]
    fn u12_on_again_the_next_hit_has_a_new_id() {
        let file = store_file("u12");
        let (at, _, width, height) = input();
        let usage = usage(&file, true);
        usage.page_view(Screen::Settings, width, height, at).unwrap();
        let (old, _) = stored_id(&file);
        usage.set_enabled(false).unwrap();
        usage.set_enabled(true).unwrap();
        assert!(!file.exists());
        assert!(usage.is_enabled());
        let body = usage.page_view(Screen::Settings, width, height, at).unwrap();
        let (new, _) = stored_id(&file);
        assert_ne!(new, old);
        assert_eq!(body["payload"]["id"], visitor_id(&new, at));

        let before = text(&file);
        usage.set_enabled(true).unwrap();
        assert_eq!(text(&file), before);
    }

    #[test]
    fn u13_a_damaged_store_counts_as_off() {
        let (at, _, width, height) = input();
        let damaged: Vec<Value> = rows("store")
            .into_iter()
            .filter(|row| row["state"] == "damaged")
            .collect();
        assert!(!damaged.is_empty());
        for (case, row) in damaged.into_iter().enumerate() {
            let file = store_file(&format!("u13-{case}"));
            let stored = row["text"].as_str().unwrap();
            put(&file, stored);
            let usage = usage(&file, true);
            assert!(!usage.is_enabled(), "{}", row["case"]);
            assert_eq!(
                usage.page_view(Screen::Settings, width, height, at),
                None,
                "{}",
                row["case"]
            );
            assert_eq!(text(&file).unwrap(), stored, "{}", row["case"]);
            usage.set_enabled(true).unwrap();
            assert!(!file.exists(), "{}", row["case"]);
        }

        let unreadable = store_file("u13-unreadable");
        std::fs::create_dir_all(&unreadable).unwrap();
        let usage = usage(&unreadable, true);
        assert!(!usage.is_enabled());
        assert_eq!(usage.page_view(Screen::Settings, width, height, at), None);
    }

    #[test]
    fn u14_an_unlisted_screen_is_refused() {
        let refused = [
            json!({ "screen": "/thread/18c2f0a9", "width": 1512, "height": 982 }),
            json!({ "screen": "/settings?q=salary", "width": 1512, "height": 982 }),
            json!({ "screen": "inbox", "width": 1512, "height": 982 }),
            json!({ "screen": "/traces/2f9c41d0", "width": 1512, "height": 982 }),
            json!({ "screen": "settings", "width": 1512, "height": 982 }),
            json!({ "screen": "Settings", "width": 1512, "height": 982 }),
            json!({ "screen": "", "width": 1512, "height": 982 }),
            json!({ "screen": "/settings", "width": 1512, "height": 982, "title": "Salary review" }),
            json!({ "screen": "/settings", "width": -1, "height": 982 }),
        ];
        for args in refused {
            assert!(serde_json::from_value::<PageViewArgs>(args.clone()).is_err(), "{args}");
        }
        let args: PageViewArgs =
            serde_json::from_value(json!({ "screen": "/settings", "width": 1512, "height": 982 })).unwrap();
        assert_eq!((args.screen, args.width, args.height), (Screen::Settings, 1512, 982));
    }

    /// `^(/([a-z0-9]+(-[a-z0-9]+)*|\[[a-z]+\]))+$`, the shared rule for a screen's url.
    fn is_fixed_path(url: &str) -> bool {
        let Some(path) = url.strip_prefix('/') else {
            return false;
        };
        path.split('/').all(|segment| {
            let kebab = segment.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            });
            let pattern = segment
                .strip_prefix('[')
                .and_then(|rest| rest.strip_suffix(']'))
                .is_some_and(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_lowercase()));
            kebab || pattern
        })
    }

    #[test]
    fn u15_screens_are_fixed_paths_with_fixed_titles() {
        assert!(!is_fixed_path("/settings?q=salary") && !is_fixed_path("/Settings") && !is_fixed_path("settings"));
        let mut urls = HashSet::new();
        let mut titles = HashSet::new();
        for &screen in Screen::ALL {
            assert!(is_fixed_path(screen.url()), "{}", screen.url());
            assert!(urls.insert(screen.url()), "{} twice", screen.url());
            assert!(titles.insert(screen.title()), "{} twice", screen.title());
            if screen.url().starts_with("/settings/") {
                assert!(screen.title().starts_with("Settings: "), "{}", screen.title());
            }
            assert_eq!(serde_json::from_value::<Screen>(json!(screen.url())).unwrap(), screen);
        }
    }

    fn header(head: &[String], name: &str) -> Option<String> {
        head.iter().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim().to_string())
        })
    }

    #[test]
    fn u16_post_sends_json_with_the_user_agent() {
        let vectors = vectors();
        assert_eq!(ENDPOINT, vectors["endpoint"]);
        assert_eq!(TIMEOUT_SECONDS, vectors["timeoutSeconds"]);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/api/send", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                head.push(line.trim_end().to_string());
            }
            let mut body = vec![0; header(&head, "content-length").unwrap().parse().unwrap()];
            reader.read_exact(&mut body).unwrap();
            let reply = "{\"beep\":\"boop\"}";
            write!(
                &stream,
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{reply}",
                reply.len()
            )
            .unwrap();
            (head, serde_json::from_slice::<Value>(&body).unwrap())
        });

        let body = vectors["payload"]["apps"]["grenier"]["expected"].clone();
        tauri::async_runtime::block_on(post(&endpoint, Os::MacOs.user_agent(), &body)).unwrap();
        let (head, received) = server.join().unwrap();
        assert_eq!(head[0], "POST /api/send HTTP/1.1");
        assert_eq!(header(&head, "content-type").as_deref(), Some("application/json"));
        assert_eq!(header(&head, "user-agent").as_deref(), Some(Os::MacOs.user_agent()));
        assert_eq!(received, body);
    }
}
