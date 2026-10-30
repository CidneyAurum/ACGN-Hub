//! Bounded, task-local ordering of a public Mikan torrent's own trackers.
//! A scrape is evidence for prioritization, never proof that the payload finished.
use crate::network;
use reqwest::Url;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

const MAX_TORRENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCRAPE_BYTES: usize = 128 * 1024;
const MAX_TRACKERS: usize = 128;
const MAX_TRACKER_OPTION_BYTES: usize = 16_384;
const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 100_000;
const MAX_BATCH: usize = 4;
const CUSTOM_TRACKER_OPTIONS: [&str; 4] = [
    "bt-tracker",
    "bt-exclude-tracker",
    "bt-tracker-connect-timeout",
    "bt-tracker-timeout",
];

#[derive(Clone, Copy)]
struct Budgets {
    total: Duration,
    metadata: Duration,
    probe: Duration,
}
impl Default for Budgets {
    fn default() -> Self {
        Self {
            total: Duration::from_secs(10),
            metadata: Duration::from_secs(4),
            probe: Duration::from_secs(3),
        }
    }
}

type FetchFuture = Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send>>;
trait Fetcher: Clone + Send + Sync + 'static {
    fn get(&self, url: Url, limit: usize, timeout: Duration) -> FetchFuture;
}

#[derive(Clone)]
struct NetworkFetcher(reqwest::Client);
impl NetworkFetcher {
    fn new() -> Option<Self> {
        // Preserve system DNS/proxy behavior and certificate checks. Redirects
        // cannot turn an original tracker probe into a request to a new tracker.
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || network::public_url(attempt.url()).is_err() {
                return attempt.error("Tracker preflight redirect rejected");
            }
            let Some(first) = attempt.previous().first() else {
                return attempt.stop();
            };
            let target = attempt.url();
            let same_origin = first.origin() == target.origin();
            let secure_upgrade = first.scheme() == "http"
                && target.scheme() == "https"
                && first.host_str() == target.host_str()
                && first.port().is_none()
                && target.port().is_none();
            if !same_origin && !secure_upgrade {
                return attempt.error("Tracker preflight origin changed");
            }
            attempt.follow()
        });
        reqwest::Client::builder()
            .user_agent(network::USER_AGENT)
            .redirect(policy)
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(4))
            .build()
            .ok()
            .map(Self)
    }
}
impl Fetcher for NetworkFetcher {
    fn get(&self, url: Url, limit: usize, timeout: Duration) -> FetchFuture {
        let client = self.0.clone();
        Box::pin(async move {
            network::public_url(&url).ok()?;
            let response = client.get(url).timeout(timeout).send().await.ok()?;
            if response.status() != reqwest::StatusCode::OK {
                return None;
            }
            crate::read_http_bytes(response, limit).await.ok()
        })
    }
}

#[derive(Debug)]
struct Node<'a> {
    value: BValue<'a>,
    start: usize,
    end: usize,
}
#[derive(Debug)]
enum BValue<'a> {
    Integer(i64),
    Bytes(&'a [u8]),
    List(Vec<Node<'a>>),
    Dict(Vec<(&'a [u8], Node<'a>)>),
}
impl<'a> Node<'a> {
    fn get(&self, key: &[u8]) -> Option<&Node<'a>> {
        match &self.value {
            BValue::Dict(entries) => entries
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }
    fn bytes(&self) -> Option<&'a [u8]> {
        match self.value {
            BValue::Bytes(value) => Some(value),
            _ => None,
        }
    }
    fn integer(&self) -> Option<i64> {
        match self.value {
            BValue::Integer(value) => Some(value),
            _ => None,
        }
    }
}
struct Decoder<'a> {
    bytes: &'a [u8],
    cursor: usize,
    nodes: usize,
}
impl<'a> Decoder<'a> {
    fn parse(bytes: &'a [u8]) -> Option<Node<'a>> {
        if bytes.is_empty() || bytes.len() > MAX_TORRENT_BYTES {
            return None;
        }
        let mut decoder = Self {
            bytes,
            cursor: 0,
            nodes: 0,
        };
        let value = decoder.node(0)?;
        (decoder.cursor == bytes.len()).then_some(value)
    }
    fn string(&mut self) -> Option<&'a [u8]> {
        let start = self.cursor;
        let colon = self
            .bytes
            .get(start..)?
            .iter()
            .take(12)
            .position(|byte| *byte == b':')?
            + start;
        let number = self.bytes.get(start..colon)?;
        if number.is_empty()
            || !number.iter().all(u8::is_ascii_digit)
            || (number.len() > 1 && number[0] == b'0')
        {
            return None;
        }
        let length = std::str::from_utf8(number).ok()?.parse::<usize>().ok()?;
        let end = colon.checked_add(1)?.checked_add(length)?;
        let value = self.bytes.get(colon + 1..end)?;
        self.cursor = end;
        Some(value)
    }
    fn node(&mut self, depth: usize) -> Option<Node<'a>> {
        if depth > MAX_DEPTH || self.nodes >= MAX_NODES {
            return None;
        }
        self.nodes += 1;
        let start = self.cursor;
        let marker = *self.bytes.get(self.cursor)?;
        let value = match marker {
            b'i' => {
                self.cursor += 1;
                let end = self
                    .bytes
                    .get(self.cursor..)?
                    .iter()
                    .take(22)
                    .position(|byte| *byte == b'e')?
                    + self.cursor;
                let encoded = std::str::from_utf8(self.bytes.get(self.cursor..end)?).ok()?;
                let digits = encoded.strip_prefix('-').unwrap_or(encoded);
                if digits.is_empty()
                    || !digits.bytes().all(|byte| byte.is_ascii_digit())
                    || (digits.len() > 1 && digits.starts_with('0'))
                    || encoded == "-0"
                {
                    return None;
                }
                let value = encoded.parse::<i64>().ok()?;
                self.cursor = end + 1;
                BValue::Integer(value)
            }
            b'l' => {
                self.cursor += 1;
                let mut values = Vec::new();
                while self.bytes.get(self.cursor) != Some(&b'e') {
                    values.push(self.node(depth + 1)?);
                }
                self.cursor += 1;
                BValue::List(values)
            }
            b'd' => {
                self.cursor += 1;
                let mut values = Vec::new();
                let mut previous: Option<&[u8]> = None;
                while self.bytes.get(self.cursor) != Some(&b'e') {
                    let key = self.string()?;
                    // Reject ambiguous duplicate/noncanonical keys, especially private/info.
                    if previous.is_some_and(|previous| previous >= key) {
                        return None;
                    }
                    previous = Some(key);
                    values.push((key, self.node(depth + 1)?));
                }
                self.cursor += 1;
                BValue::Dict(values)
            }
            b'0'..=b'9' => BValue::Bytes(self.string()?),
            _ => return None,
        };
        Some(Node {
            value,
            start,
            end: self.cursor,
        })
    }
}

struct Torrent {
    info_hash: [u8; 20],
    trackers: Vec<String>,
}

fn tracker_url(value: &str) -> Option<Url> {
    if value.is_empty()
        || value.len() > 2048
        || value.trim() != value
        || value.contains(',')
        || value.chars().any(char::is_control)
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https" | "udp")
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return None;
    }
    // Normalize UDP's non-special URL authority through HTTP as well, so short
    // numeric hosts such as 127.1 cannot evade the shared public-host check.
    let public = Url::parse(&format!(
        "http://{}:{}/",
        url.host_str()?,
        url.port().unwrap_or(80)
    ))
    .ok()?;
    if crate::is_private_feed_host(public.host_str()?.trim_end_matches('.')) {
        return None;
    }
    network::public_url(&public).ok()?;
    Some(url)
}

pub(super) fn valid_tracker_options(value: &str) -> bool {
    if value.len() > MAX_TRACKER_OPTION_BYTES {
        return false;
    }
    let entries: Vec<_> = value.split(',').collect();
    !entries.is_empty()
        && entries.len() <= MAX_TRACKERS
        && entries.iter().all(|uri| tracker_url(uri).is_some())
}

fn torrent(bytes: &[u8]) -> Option<Torrent> {
    let root = Decoder::parse(bytes)?;
    let info = root.get(b"info")?;
    if !matches!(info.value, BValue::Dict(_)) {
        return None;
    }
    match info.get(b"private").map(Node::integer) {
        None | Some(Some(0)) => {}
        _ => return None, // Private or malformed private flags never get probed.
    }
    let info_hash: [u8; 20] = Sha1::digest(bytes.get(info.start..info.end)?).into();
    let mut trackers = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |value: &Node<'_>| -> Option<()> {
        let value = std::str::from_utf8(value.bytes()?).ok()?;
        tracker_url(value)?;
        if seen.insert(value.to_string()) {
            trackers.push(value.to_string());
        }
        (trackers.len() <= MAX_TRACKERS).then_some(())
    };
    if let Some(list) = root.get(b"announce-list") {
        let BValue::List(tiers) = &list.value else {
            return None;
        };
        for tier in tiers {
            let BValue::List(urls) = &tier.value else {
                return None;
            };
            for uri in urls {
                push(uri)?;
            }
        }
    } else {
        push(root.get(b"announce")?)?;
    }
    if trackers.is_empty() || trackers.join(",").len() > MAX_TRACKER_OPTION_BYTES {
        return None;
    }
    Some(Torrent {
        info_hash,
        trackers,
    })
}

fn mikan_url(value: &str) -> Option<(Url, String)> {
    let url = Url::parse(value).ok()?;
    network::public_url(&url).ok()?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("mikanani.me" | "www.mikanani.me"))
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/Download/")
    {
        return None;
    }
    let name = url.path_segments()?.next_back()?;
    let hash = name.strip_suffix(".torrent")?;
    if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let hash = hash.to_ascii_lowercase();
    Some((url, hash))
}

fn scrape_url(value: &str, info_hash: &[u8; 20]) -> Option<Url> {
    let mut url = tracker_url(value)?;
    // Do not send passkeys/query credentials or guess token-bearing paths.
    if !matches!(url.scheme(), "http" | "https") || url.query().is_some() {
        return None;
    }
    let scrape_path = match url.path() {
        "/announce" => "/scrape",
        "/announce.php" => "/scrape.php",
        _ => return None,
    };
    url.set_path(scrape_path);
    let escaped = info_hash
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect::<String>();
    url.set_query(Some(&format!("info_hash={escaped}")));
    Some(url)
}

fn scrape_peers(bytes: &[u8], info_hash: &[u8; 20]) -> Option<u64> {
    if bytes.len() > MAX_SCRAPE_BYTES {
        return None;
    }
    let root = Decoder::parse(bytes)?;
    if root.get(b"failure reason").is_some() {
        return None;
    }
    let statistics = root.get(b"files")?.get(info_hash)?;
    let complete = u64::try_from(statistics.get(b"complete")?.integer()?).ok()?;
    let incomplete = u64::try_from(statistics.get(b"incomplete")?.integer()?).ok()?;
    complete.checked_add(incomplete)
}

struct TrackerPlan {
    ordered: Vec<String>,
    checked: usize,
    positive: usize,
}
impl TrackerPlan {
    fn apply(&self, options: &mut Value) -> bool {
        let Some(options) = options.as_object_mut() else {
            return false;
        };
        if CUSTOM_TRACKER_OPTIONS
            .iter()
            .any(|name| options.contains_key(*name))
        {
            return false;
        }
        options.insert("bt-tracker".into(), Value::String(self.ordered.join(",")));
        options.insert("bt-exclude-tracker".into(), Value::String("*".into()));
        options.insert(
            "bt-tracker-connect-timeout".into(),
            Value::String("5".into()),
        );
        options.insert("bt-tracker-timeout".into(), Value::String("10".into()));
        true
    }
}

async fn make_plan<F: Fetcher>(
    source: Url,
    expected_hash: String,
    fetcher: F,
    budgets: Budgets,
) -> Option<TrackerPlan> {
    let started = Instant::now();
    let bytes = tokio::time::timeout(
        budgets.metadata,
        fetcher.get(source, MAX_TORRENT_BYTES, budgets.metadata),
    )
    .await
    .ok()??;
    let torrent = torrent(&bytes)?;
    let actual_hash = torrent
        .info_hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual_hash != expected_hash {
        return None;
    }
    let mut outcomes = vec![None; torrent.trackers.len()];
    let mut checked = vec![false; torrent.trackers.len()];
    // Preserve separate coverage for HTTPS and the first eight HTTP trackers.
    // Some real Mikan torrents put their available HTTP tracker eighth.
    let mut batches = Vec::new();
    for (scheme, maximum) in [("https", 4), ("http", 8)] {
        let candidates: Vec<_> = torrent
            .trackers
            .iter()
            .enumerate()
            .filter_map(|(index, original)| {
                let url = scrape_url(original, &torrent.info_hash)?;
                (url.scheme() == scheme).then_some((index, url))
            })
            .take(maximum)
            .collect();
        for batch in candidates.chunks(MAX_BATCH) {
            batches.push(batch.to_vec());
        }
    }
    for (batch_index, candidates) in batches.iter().enumerate() {
        // Reserve a fair share for later batches instead of allowing earlier
        // dead trackers to consume the entire total deadline.
        let remaining = budgets.total.checked_sub(started.elapsed())?;
        let reserve = Duration::from_millis(50).min(remaining / 10);
        let available = remaining.checked_sub(reserve)?;
        let probe_budget = budgets
            .probe
            .min(available / (batches.len() - batch_index) as u32);
        if probe_budget.is_zero() {
            return None;
        }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, url) in candidates {
            let index = *index;
            let url = url.clone();
            let fetcher = fetcher.clone();
            let hash = torrent.info_hash;
            tasks.spawn(async move {
                let response = tokio::time::timeout(
                    probe_budget,
                    fetcher.get(url, MAX_SCRAPE_BYTES, probe_budget),
                )
                .await
                .ok()
                .flatten();
                (
                    index,
                    response.and_then(|bytes| scrape_peers(&bytes, &hash)),
                )
            });
        }
        while let Some(result) = tasks.join_next().await {
            if let Ok((index, peers)) = result {
                checked[index] = true;
                outcomes[index] = peers;
                if peers.is_some_and(|peers| peers > 0) {
                    // Do not discard an established positive while waiting for
                    // the other requests to run into the outer total deadline.
                    tasks.abort_all();
                    while let Some(completed) = tasks.join_next().await {
                        if let Ok((index, peers)) = completed {
                            checked[index] = true;
                            outcomes[index] = peers;
                        }
                    }
                    break;
                }
            }
        }
        if outcomes.iter().flatten().any(|peers| *peers > 0) {
            break;
        }
    }
    let positive = outcomes
        .iter()
        .flatten()
        .filter(|peers| **peers > 0)
        .count();
    if positive == 0 {
        return None;
    }
    let mut indexes: Vec<_> = (0..torrent.trackers.len()).collect();
    indexes.sort_by_key(|index| {
        let (group, peers) = match outcomes[*index] {
            Some(peers) if peers > 0 => (0, u64::MAX - peers),
            None if !checked[*index] => (1, 0), // Unknown may still have useful peers.
            Some(0) => (2, 0),
            _ => (3, 0),
        };
        (group, peers, *index)
    });
    Some(TrackerPlan {
        ordered: indexes
            .into_iter()
            .map(|index| torrent.trackers[index].clone())
            .collect(),
        checked: checked.into_iter().filter(|value| *value).count(),
        positive,
    })
}

pub(super) async fn prioritize_mikan(params: &mut [Value]) -> bool {
    let Some(urls) = params.first().and_then(Value::as_array) else {
        return false;
    };
    if urls.len() != 1 {
        return false;
    }
    let Some((url, hash)) = urls[0].as_str().and_then(mikan_url) else {
        return false;
    };
    let Some(options) = params.get(1).and_then(Value::as_object) else {
        return false;
    };
    if options.get("follow-torrent").and_then(Value::as_str) != Some("mem")
        || CUSTOM_TRACKER_OPTIONS
            .iter()
            .any(|name| options.contains_key(*name))
    {
        return false;
    }
    let Some(fetcher) = NetworkFetcher::new() else {
        return false;
    };
    prioritize_with(params, url, hash, fetcher, Budgets::default()).await
}

async fn prioritize_with<F: Fetcher>(
    params: &mut [Value],
    url: Url,
    hash: String,
    fetcher: F,
    budgets: Budgets,
) -> bool {
    let result = tokio::time::timeout(budgets.total, make_plan(url, hash, fetcher, budgets))
        .await
        .ok()
        .flatten();
    let Some(plan) = result else {
        return false;
    };
    let changed = plan.apply(&mut params[1]);
    if changed {
        // Counts only: never log tracker URLs, passkeys, headers or the magnet.
        crate::diagnostics::record(&format!(
            "aria2.mikan_preflight.prioritized checked={} positive={}",
            plan.checked, plan.positive
        ));
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    fn string(value: &[u8]) -> Vec<u8> {
        let mut out = format!("{}:", value.len()).into_bytes();
        out.extend(value);
        out
    }
    fn dictionary(entries: Vec<(&[u8], Vec<u8>)>) -> Vec<u8> {
        let mut out = vec![b'd'];
        for (key, value) in entries.into_iter().collect::<BTreeMap<_, _>>() {
            out.extend(string(key));
            out.extend(value);
        }
        out.push(b'e');
        out
    }
    fn list(values: Vec<Vec<u8>>) -> Vec<u8> {
        let mut out = vec![b'l'];
        for value in values {
            out.extend(value);
        }
        out.push(b'e');
        out
    }
    fn fixture(trackers: &[&str], private: bool) -> (Vec<u8>, [u8; 20], Url) {
        let mut entries = vec![
            (b"length".as_slice(), b"i416074928e".to_vec()),
            (b"name".as_slice(), string(b"sample.mp4")),
            (b"piece length".as_slice(), b"i262144e".to_vec()),
            (b"pieces".as_slice(), string(b"01234567890123456789")),
        ];
        if private {
            entries.push((b"private".as_slice(), b"i1e".to_vec()));
        }
        let info = dictionary(entries);
        let hash: [u8; 20] = Sha1::digest(&info).into();
        let bytes = dictionary(vec![
            (
                b"announce",
                string(
                    trackers
                        .first()
                        .unwrap_or(&"https://example.invalid/announce")
                        .as_bytes(),
                ),
            ),
            (
                b"announce-list",
                list(
                    trackers
                        .iter()
                        .map(|tracker| list(vec![string(tracker.as_bytes())]))
                        .collect(),
                ),
            ),
            (b"info", info),
        ]);
        let hash_hex = hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let url = Url::parse(&format!(
            "https://mikanani.me/Download/20261007/{hash_hex}.torrent"
        ))
        .unwrap();
        (bytes, hash, url)
    }
    fn scrape(hash: &[u8; 20], complete: i64, incomplete: i64) -> Vec<u8> {
        dictionary(vec![(
            b"files",
            dictionary(vec![(
                hash,
                dictionary(vec![
                    (b"complete", format!("i{complete}e").into_bytes()),
                    (b"incomplete", format!("i{incomplete}e").into_bytes()),
                ]),
            )]),
        )])
    }
    fn params(url: &Url) -> Vec<Value> {
        vec![
            serde_json::json!([url.as_str()]),
            serde_json::json!({"dir":"D:\\UserLibrary\\Incoming", "follow-torrent":"mem", "bt-stop-timeout":"0", "allow-overwrite":"false"}),
        ]
    }
    #[derive(Clone)]
    struct MockFetcher {
        responses: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        delays: Arc<Mutex<BTreeMap<String, Duration>>>,
        calls: Arc<Mutex<Vec<String>>>,
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
        delay: Duration,
    }
    impl MockFetcher {
        fn new(url: &Url, metadata: Vec<u8>) -> Self {
            Self {
                responses: Arc::new(Mutex::new(BTreeMap::from([(url.to_string(), metadata)]))),
                delays: Arc::new(Mutex::new(BTreeMap::new())),
                calls: Arc::new(Mutex::new(Vec::new())),
                active: Arc::new(AtomicUsize::new(0)),
                maximum: Arc::new(AtomicUsize::new(0)),
                delay: Duration::ZERO,
            }
        }
        fn add(&self, original: &str, hash: &[u8; 20], body: Vec<u8>) {
            self.responses
                .lock()
                .unwrap()
                .insert(scrape_url(original, hash).unwrap().to_string(), body);
        }
    }
    impl Fetcher for MockFetcher {
        fn get(&self, url: Url, limit: usize, _timeout: Duration) -> FetchFuture {
            let this = self.clone();
            Box::pin(async move {
                struct Active(Arc<AtomicUsize>);
                impl Drop for Active {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                let active = this.active.fetch_add(1, Ordering::SeqCst) + 1;
                let _active = Active(this.active.clone());
                this.maximum.fetch_max(active, Ordering::SeqCst);
                this.calls.lock().unwrap().push(url.to_string());
                let delay = this
                    .delays
                    .lock()
                    .unwrap()
                    .get(url.as_str())
                    .copied()
                    .unwrap_or(this.delay);
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let body = this.responses.lock().unwrap().get(url.as_str()).cloned()?;
                (body.len() <= limit).then_some(body)
            })
        }
    }
    async fn run(params: &mut [Value], url: &Url, fetcher: MockFetcher) -> bool {
        prioritize_with(
            params,
            url.clone(),
            mikan_url(url.as_str()).unwrap().1,
            fetcher,
            Budgets::default(),
        )
        .await
    }

    #[test]
    fn metainfo_hashes_the_original_info_span_and_preserves_all_original_trackers() {
        let original = [
            "https://first.example/announce",
            "udp://last.example:6969/announce",
        ];
        let (bytes, hash, _) = fixture(&original, false);
        let parsed = torrent(&bytes).unwrap();
        assert_eq!(parsed.info_hash, hash);
        assert_eq!(parsed.trackers, original);
        // Changes outside info must not change the hash used for the scrape.
        let (other, same_hash, _) = fixture(&["https://other.example/announce"], false);
        assert_eq!(torrent(&other).unwrap().info_hash, hash);
        assert_eq!(hash, same_hash);
        assert_eq!(torrent(&bytes).unwrap().trackers.len(), 2);
    }

    #[test]
    fn decoder_rejects_ambiguous_private_flags_malformed_and_unbounded_input() {
        for input in [
            b"d4:infod7:privatei0e7:privatei1eee".as_slice(),
            b"d4:infod7:private1:0ee",
            b"i-0e",
            b"i01e",
            b"01:x",
            b"d1:bi1e1:ai2ee",
            b"degarbage",
            b"<html>Denied</html>",
        ] {
            assert!(torrent(input).is_none(), "{input:?}");
        }
        let nested = format!(
            "{}0:{}",
            "l".repeat(MAX_DEPTH + 2),
            "e".repeat(MAX_DEPTH + 2)
        );
        assert!(Decoder::parse(nested.as_bytes()).is_none());
        let nodes = format!("l{}e", "0:".repeat(MAX_NODES + 1));
        assert!(Decoder::parse(nodes.as_bytes()).is_none());
        assert!(Decoder::parse(&vec![0; MAX_TORRENT_BYTES + 1]).is_none());
    }

    #[test]
    fn scrape_requires_the_exact_hash_and_valid_nonnegative_peer_counts() {
        let hash = [42_u8; 20];
        assert_eq!(scrape_peers(&scrape(&hash, 0, 3), &hash), Some(3));
        assert_eq!(scrape_peers(&scrape(&hash, 0, 0), &hash), Some(0));
        assert_eq!(scrape_peers(&scrape(&[41; 20], 77, 1), &hash), None);
        assert_eq!(scrape_peers(&scrape(&hash, -1, 2), &hash), None);
        assert_eq!(
            scrape_peers(
                &dictionary(vec![
                    (b"failure reason", string(b"Unavailable")),
                    (b"files", dictionary(vec![]))
                ]),
                &hash
            ),
            None
        );
        assert_eq!(
            scrape_peers(b"<html>HTTP 200 challenge</html>", &hash),
            None
        );
        assert_eq!(scrape_peers(&vec![0; MAX_SCRAPE_BYTES + 1], &hash), None);
    }

    #[test]
    fn urls_are_public_scoped_and_token_paths_are_never_probed() {
        let (_, hash, source) = fixture(&["https://a.example/announce"], false);
        assert!(mikan_url(source.as_str()).is_some());
        for url in [
            "https://evil.mikanani.me/Download/20261007/abc.torrent",
            "https://mikanani.me.evil.example/Download/abc.torrent",
            "http://mikanani.me/Download/abc.torrent",
            "https://mikanani.me/Download/abc.torrent?token=private",
        ] {
            assert!(mikan_url(url).is_none());
        }
        for url in [
            "http://127.0.0.1/announce",
            "https://user:pass@example.com/announce",
            "udp://192.168.1.2:6969/announce",
            "https://a.example/announce#private",
            "https://a.example/announce,https://b.example/announce",
        ] {
            assert!(tracker_url(url).is_none());
        }
        for url in [
            "https://a.example/announce?passkey=private",
            "https://a.example/private-token/announce",
            "udp://a.example:6969/announce",
        ] {
            assert!(scrape_url(url, &hash).is_none());
        }
        let url = scrape_url("https://a.example/announce", &hash).unwrap();
        assert_eq!(url.path(), "/scrape");
        assert!(url.query().unwrap().starts_with("info_hash=%"));
    }

    #[tokio::test]
    async fn positive_original_trackers_move_first_without_modifying_source_info_or_output() {
        let originals = [
            "http://old.example/announce",
            "https://empty.example/announce",
            "https://working.example/announce",
            "https://broken.example/announce",
            "udp://fallback.example:6969/announce",
            "https://other.example/token/announce",
        ];
        let (bytes, hash, url) = fixture(&originals, false);
        let fetcher = MockFetcher::new(&url, bytes.clone());
        fetcher.add(originals[1], &hash, scrape(&hash, 0, 0));
        fetcher.add(originals[2], &hash, scrape(&hash, 0, 3)); // Partial peers are useful too.
        let mut task = params(&url);
        let original_options = task[1].clone();
        assert!(run(&mut task, &url, fetcher.clone()).await);
        let ordered = task[1]["bt-tracker"]
            .as_str()
            .unwrap()
            .split(',')
            .collect::<Vec<_>>();
        assert_eq!(
            ordered,
            [
                originals[2],
                originals[0],
                originals[4],
                originals[5],
                originals[1],
                originals[3]
            ]
        );
        assert_eq!(
            ordered.iter().copied().collect::<HashSet<_>>(),
            originals.into_iter().collect::<HashSet<_>>()
        );
        assert_eq!(task[0], serde_json::json!([url.as_str()]));
        for key in [
            "dir",
            "follow-torrent",
            "allow-overwrite",
            "bt-stop-timeout",
        ] {
            assert_eq!(task[1][key], original_options[key]);
        }
        assert_eq!(task[1]["bt-exclude-tracker"], "*");
        assert_eq!(task[1]["bt-tracker-connect-timeout"], "5");
        assert_eq!(task[1]["bt-tracker-timeout"], "10");
        assert_eq!(torrent(&bytes).unwrap().info_hash, hash);
        assert!(!fetcher
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|url| url.contains("/token/") || url.contains("http://old.example")));
    }

    #[tokio::test]
    async fn private_hash_mismatch_failed_and_all_zero_results_preserve_initial_options() {
        let originals = ["https://one.example/announce"];
        for private in [false, true] {
            let (bytes, hash, url) = fixture(&originals, private);
            let fetcher = MockFetcher::new(&url, bytes);
            fetcher.add(originals[0], &hash, scrape(&hash, 0, 0));
            let mut task = params(&url);
            let before = task.clone();
            assert!(!run(&mut task, &url, fetcher.clone()).await);
            assert_eq!(task, before);
            if private {
                assert_eq!(fetcher.calls.lock().unwrap().len(), 1);
            }
        }
        let (bytes, _, url) = fixture(&originals, false);
        let fetcher = MockFetcher::new(&url, bytes);
        let mut task = params(&url);
        let before = task.clone();
        assert!(
            !prioritize_with(
                &mut task,
                url,
                "0".repeat(40),
                fetcher.clone(),
                Budgets::default()
            )
            .await
        );
        assert_eq!(task, before);
        assert_eq!(fetcher.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn probing_has_separate_https_http_caps_and_at_most_four_concurrent_requests() {
        let https: Vec<_> = (0..8)
            .map(|index| format!("https://secure{index}.example/announce"))
            .collect();
        let http: Vec<_> = (0..8)
            .map(|index| format!("http://plain{index}.example/announce"))
            .collect();
        let originals: Vec<_> = http
            .iter()
            .chain(https.iter())
            .map(String::as_str)
            .collect();
        let (bytes, hash, url) = fixture(&originals, false);
        let mut fetcher = MockFetcher::new(&url, bytes);
        fetcher.delay = Duration::from_millis(2);
        fetcher.add(&http[7], &hash, scrape(&hash, 48, 0));
        let mut task = params(&url);
        assert!(run(&mut task, &url, fetcher.clone()).await);
        let calls = fetcher.calls.lock().unwrap();
        assert_eq!(calls.len(), 13); // One metainfo + four HTTPS + eight HTTP.
        for call in &calls[1..5] {
            assert!(call.starts_with("https://secure"));
        }
        for call in &calls[5..] {
            assert!(call.starts_with("http://plain"));
        }
        assert_eq!(fetcher.maximum.load(Ordering::SeqCst), 4);
        assert_eq!(
            task[1]["bt-tracker"].as_str().unwrap().split(',').count(),
            16
        );
        assert_eq!(
            task[1]["bt-tracker"].as_str().unwrap().split(',').next(),
            Some(http[7].as_str())
        );
    }

    #[tokio::test]
    async fn real_shape_anibt_failure_still_reaches_eighth_http_nyaa_tracker() {
        let http = [
            "http://tr.bangumi.moe:6969/announce",
            "http://t.nyaatracker.com/announce",
            "http://open.acgtracker.com:1096/announce",
            "http://open.nyaatorrents.info:6544/announce",
            "http://bt.sc-ol.com:2710/announce",
            "http://t.acg.rip:6699/announce",
            "http://opentracker.acgnx.se/announce",
            "http://nyaa.tracker.wf:7777/announce",
        ];
        let originals: Vec<_> = http
            .iter()
            .copied()
            .chain([
                "https://tracker.anibt.net/announce",
                "https://unavailable.example/announce",
                "udp://original-fallback.example:6969/announce",
            ])
            .collect();
        let (bytes, hash, url) = fixture(&originals, false);
        let fetcher = MockFetcher::new(&url, bytes);
        fetcher.add(http[7], &hash, scrape(&hash, 48, 0));
        let mut task = params(&url);
        assert!(run(&mut task, &url, fetcher.clone()).await);
        assert_eq!(
            task[1]["bt-tracker"].as_str().unwrap().split(',').next(),
            Some(http[7])
        );
        let calls = fetcher.calls.lock().unwrap();
        assert!(calls
            .iter()
            .any(|url| url.starts_with("https://tracker.anibt.net/scrape")));
        assert!(calls
            .iter()
            .any(|url| url.starts_with("http://nyaa.tracker.wf:7777/scrape")));
        assert_eq!(
            task[1]["bt-tracker"]
                .as_str()
                .unwrap()
                .split(',')
                .collect::<HashSet<_>>(),
            originals.into_iter().collect::<HashSet<_>>()
        );
    }

    #[tokio::test]
    async fn positive_scrape_cancels_slow_siblings_and_keeps_them_as_unknown_fallbacks() {
        let originals = [
            "https://working.example/announce",
            "https://slow.example/announce",
            "udp://fallback.example:6969/announce",
        ];
        let (bytes, hash, url) = fixture(&originals, false);
        let fetcher = MockFetcher::new(&url, bytes);
        fetcher.add(originals[0], &hash, scrape(&hash, 1, 0));
        fetcher.delays.lock().unwrap().insert(
            scrape_url(originals[1], &hash).unwrap().to_string(),
            Duration::from_secs(1),
        );
        let mut task = params(&url);
        let budgets = Budgets {
            total: Duration::from_secs(2),
            metadata: Duration::from_secs(1),
            probe: Duration::from_secs(1),
        };
        let changed = tokio::time::timeout(
            Duration::from_millis(100),
            prioritize_with(
                &mut task,
                url.clone(),
                mikan_url(url.as_str()).unwrap().1,
                fetcher.clone(),
                budgets,
            ),
        )
        .await
        .expect("positive result must not wait for the slow sibling");
        assert!(changed);
        assert_eq!(
            task[1]["bt-tracker"]
                .as_str()
                .unwrap()
                .split(',')
                .collect::<Vec<_>>(),
            originals
        );
        assert_eq!(fetcher.active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn total_deadline_and_custom_settings_are_non_destructive() {
        let (bytes, _, url) = fixture(&["https://one.example/announce"], false);
        let mut fetcher = MockFetcher::new(&url, bytes);
        fetcher.delay = Duration::from_millis(100);
        let mut task = params(&url);
        let before = task.clone();
        let budgets = Budgets {
            total: Duration::from_millis(5),
            metadata: Duration::from_secs(1),
            probe: Duration::from_secs(1),
        };
        let changed = tokio::time::timeout(
            Duration::from_millis(200),
            prioritize_with(&mut task, url, "0".repeat(40), fetcher.clone(), budgets),
        )
        .await
        .unwrap();
        assert!(!changed);
        assert_eq!(task, before);
        assert_eq!(fetcher.active.load(Ordering::SeqCst), 0);
        let plan = TrackerPlan {
            ordered: vec!["https://one.example/announce".into()],
            checked: 1,
            positive: 1,
        };
        let mut custom = serde_json::json!({"bt-tracker":"https://custom.example/announce"});
        let original = custom.clone();
        assert!(!plan.apply(&mut custom));
        assert_eq!(custom, original);
        let mut custom_timeout = serde_json::json!({"bt-tracker-connect-timeout":"30"});
        let original = custom_timeout.clone();
        assert!(!plan.apply(&mut custom_timeout));
        assert_eq!(custom_timeout, original);
    }

    #[tokio::test]
    #[ignore = "Explicit local sample audit; set ACGN_TEST_TORRENT_PATH and ACGN_TEST_INFO_HASH. No network."]
    async fn explicit_local_metainfo_sample_with_mock_scrape_preserves_identity() {
        let path = std::env::var_os("ACGN_TEST_TORRENT_PATH").expect("explicit sample path");
        let bytes = std::fs::read(path).expect("read explicitly selected local sample");
        let parsed = torrent(&bytes).expect("valid public metainfo");
        let hash = parsed
            .info_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            hash,
            std::env::var("ACGN_TEST_INFO_HASH").expect("independently known infohash")
        );
        let url = Url::parse(&format!(
            "https://mikanani.me/Download/20000101/{hash}.torrent"
        ))
        .unwrap();
        let original_count = parsed.trackers.len();
        let selected = parsed
            .trackers
            .iter()
            .find(|value| {
                value.starts_with("https://") && scrape_url(value, &parsed.info_hash).is_some()
            })
            .unwrap()
            .clone();
        let fetcher = MockFetcher::new(&url, bytes.clone());
        fetcher.add(
            &selected,
            &parsed.info_hash,
            scrape(&parsed.info_hash, 0, 2),
        );
        let mut task = params(&url);
        let original_url = task[0].clone();
        let original_directory = task[1]["dir"].clone();
        assert!(run(&mut task, &url, fetcher).await);
        let actual = task[1]["bt-tracker"]
            .as_str()
            .unwrap()
            .split(',')
            .collect::<Vec<_>>();
        assert_eq!(actual[0], selected);
        assert_eq!(actual.len(), original_count);
        assert_eq!(
            actual.into_iter().collect::<HashSet<_>>(),
            parsed
                .trackers
                .iter()
                .map(String::as_str)
                .collect::<HashSet<_>>()
        );
        assert_eq!(task[0], original_url);
        assert_eq!(task[1]["dir"], original_directory);
        assert_eq!(torrent(&bytes).unwrap().info_hash, parsed.info_hash);
        println!("local_metainfo_identity_preserved=true original_tracker_count={original_count} mock_scrape_only=true");
    }
}
