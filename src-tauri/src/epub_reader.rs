//! Read-only EPUB conversion. Only plain text and verified bitmap references
//! leave this module. Book HTML, CSS, scripts and network URLs are never run.
use crate::image_format::ImageFormat;
use quick_xml::{events::Event, Reader};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 50 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENTRIES: usize = 4_096;
const MAX_BLOCKS: usize = 40_000;
const MAX_CHAPTERS: usize = 1_000;
const MAX_IMAGES: usize = 1_000;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubBook {
    pub blocks: Vec<EpubBlock>,
    pub chapters: Vec<EpubChapter>,
    pub images: Vec<EpubImage>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubBlock {
    pub text: String,
    pub heading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_index: Option<usize>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapter {
    pub title: String,
    pub block_index: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubImage {
    /// Original ZIP entry index, not the displayed illustration number.
    pub index: usize,
    pub name: String,
    pub size: u64,
}

#[derive(Clone)]
struct Entry {
    index: usize,
    size: u64,
}

#[derive(Default, Debug)]
struct Element {
    name: String,
    attributes: HashMap<String, String>,
    children: Vec<Node>,
}

#[derive(Debug)]
enum Node {
    Element(Element),
    Text(String),
}

impl Element {
    fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes.get(name).map(String::as_str)
    }

    fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find_map(|node| match node {
            Node::Element(element) if element.name == name => Some(element),
            _ => None,
        })
    }

    fn descendants<'a>(&'a self, name: &str, result: &mut Vec<&'a Element>) {
        if self.name == name {
            result.push(self);
        }
        for node in &self.children {
            if let Node::Element(element) = node {
                element.descendants(name, result);
            }
        }
    }

    fn text(&self) -> String {
        let mut result = String::new();
        self.append_text(&mut result);
        collapse_whitespace(&result)
    }

    fn append_text(&self, result: &mut String) {
        for node in &self.children {
            match node {
                Node::Text(text) => result.push_str(text),
                Node::Element(element)
                    if !matches!(element.name.as_str(), "script" | "style" | "rt" | "rp") =>
                {
                    element.append_text(result)
                }
                _ => {}
            }
        }
    }
}

pub fn read_epub(file: &mut File) -> Result<EpubBook, String> {
    preflight(file)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "EPUB 不是有效的 ZIP 电子书，或文件已损坏")?;
    let entries = inspect_entries(&mut archive)?;
    if entries.contains_key("META-INF/encryption.xml")
        || entries.contains_key("META-INF/rights.xml")
    {
        return Err("应用内阅读不支持 DRM 或加密 EPUB，请使用来源指定的阅读器".into());
    }
    if read_string(&mut archive, &entries, "mimetype", 128)?.trim() != "application/epub+zip" {
        return Err("文件缺少有效 EPUB 类型标记".into());
    }
    let container = read_xml(&mut archive, &entries, "META-INF/container.xml")?;
    if container.name != "container" {
        return Err("EPUB 容器目录无效".into());
    }
    let mut rootfiles = Vec::new();
    container.descendants("rootfile", &mut rootfiles);
    let rootfile = rootfiles
        .iter()
        .find(|element| element.attribute("media-type") == Some("application/oebps-package+xml"))
        .or_else(|| rootfiles.first())
        .ok_or("EPUB 未提供正文目录")?;
    let package_path = resolve_reference(
        "",
        rootfile
            .attribute("full-path")
            .ok_or("EPUB 正文目录路径缺失")?,
    )?;
    let package = read_xml(&mut archive, &entries, &package_path)?;
    if package.name != "package" {
        return Err("EPUB 正文目录无效".into());
    }
    let manifest_node = package.child("manifest").ok_or("EPUB 缺少资源清单")?;
    let spine = package.child("spine").ok_or("EPUB 缺少阅读顺序")?;
    let mut manifest = HashMap::<String, (String, String)>::new();
    let mut navigation = Vec::new();
    for node in &manifest_node.children {
        let Node::Element(element) = node else {
            continue;
        };
        if element.name != "item" {
            continue;
        }
        let id = element
            .attribute("id")
            .filter(|id| !id.is_empty())
            .ok_or("EPUB 资源缺少身份标记")?;
        let path = resolve_reference(
            &package_path,
            element.attribute("href").ok_or("EPUB 资源路径缺失")?,
        )?;
        let media_type = element
            .attribute("media-type")
            .unwrap_or("")
            .to_ascii_lowercase();
        if manifest
            .insert(id.to_owned(), (path.clone(), media_type.clone()))
            .is_some()
        {
            return Err("EPUB 资源身份重复，无法确定正文".into());
        }
        if media_type == "application/x-dtbncx+xml"
            || element
                .attribute("properties")
                .unwrap_or("")
                .split_whitespace()
                .any(|property| property == "nav")
        {
            navigation.push(path);
        }
    }
    let mut labels = HashMap::new();
    for navigation_path in navigation {
        let document = read_xml(&mut archive, &entries, &navigation_path)?;
        collect_navigation(&document, &navigation_path, &mut labels)?;
    }
    let mut ordered = Vec::new();
    let mut selected = HashSet::new();
    for node in &spine.children {
        let Node::Element(element) = node else {
            continue;
        };
        if element.name != "itemref" || element.attribute("linear") == Some("no") {
            continue;
        }
        let id = element
            .attribute("idref")
            .ok_or("EPUB 阅读顺序缺少资源身份")?;
        let (path, media_type) = manifest.get(id).ok_or("EPUB 阅读顺序引用了不存在的正文")?;
        if !matches!(media_type.as_str(), "application/xhtml+xml" | "text/html") {
            return Err("EPUB 正文格式暂不支持，请使用系统阅读器打开".into());
        }
        if !selected.insert(path.clone()) {
            return Err("EPUB 阅读顺序包含重复正文，已停止读取".into());
        }
        ordered.push(path.clone());
        if ordered.len() > MAX_CHAPTERS {
            return Err("EPUB 正文章节超过 1000 项，已停止读取".into());
        }
    }
    if ordered.is_empty() {
        return Err("EPUB 没有可阅读的正文".into());
    }
    let mut book = EpubBook {
        blocks: Vec::new(),
        chapters: Vec::new(),
        images: Vec::new(),
    };
    let mut image_numbers = HashMap::new();
    let mut text_bytes = 0;
    for (position, path) in ordered.iter().enumerate() {
        let document = read_xml(&mut archive, &entries, path)?;
        if document.name != "html" {
            return Err("EPUB 正文不是有效 XHTML 页面".into());
        }
        let body = document.child("body").ok_or("EPUB 正文页面缺少内容区域")?;
        let mut title = labels.get(path).cloned().unwrap_or_default();
        if title.is_empty() {
            title = first_heading(body).unwrap_or_default();
        }
        if title.is_empty() {
            title = document
                .child("head")
                .and_then(|head| head.child("title"))
                .map(Element::text)
                .unwrap_or_default();
        }
        if title.is_empty() {
            title = format!("第 {} 节", position + 1);
        }
        // Match the IPC validator's JavaScript string limit without splitting
        // an emoji's surrogate pair. Full body text remains untouched.
        let title = bounded_chapter_title(&title);
        let block_index = book.blocks.len();
        push_block(
            &mut book,
            EpubBlock {
                text: title.clone(),
                heading: true,
                image_index: None,
            },
            &mut text_bytes,
        )?;
        book.chapters.push(EpubChapter {
            title: title.clone(),
            block_index,
        });
        let mut renderer = Renderer {
            archive: &mut archive,
            entries: &entries,
            path,
            book: &mut book,
            image_numbers: &mut image_numbers,
            text_bytes: &mut text_bytes,
            pending: String::new(),
            skip_heading: Some(title),
            meaningful: false,
        };
        renderer.children(body)?;
        renderer.flush(false)?;
    }
    if !book
        .blocks
        .iter()
        .any(|block| !block.heading && (!block.text.is_empty() || block.image_index.is_some()))
    {
        return Err("EPUB 只有目录标题，没有可阅读的正文或插图".into());
    }
    Ok(book)
}

fn inspect_entries<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<HashMap<String, Entry>, String> {
    if archive.len() > MAX_ENTRIES {
        return Err("EPUB 归档条目超过 4096 项，已停止读取".into());
    }
    let mut entries = HashMap::new();
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "EPUB 包含无法读取或加密的条目")?;
        if entry.encrypted() {
            return Err("应用内阅读不支持加密 EPUB".into());
        }
        let name = entry.name();
        let checked_name = name.trim_end_matches('/');
        if checked_name.is_empty()
            || checked_name.starts_with('/')
            || checked_name.contains('\\')
            || checked_name.contains(':')
            || checked_name.chars().any(char::is_control)
            || checked_name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("EPUB 包含无效路径或符号链接，已停止读取".into());
        }
        if !seen.insert(name.to_owned()) {
            return Err("EPUB 包含重复归档路径，无法确定正文".into());
        }
        total = total.checked_add(entry.size()).ok_or("EPUB 解压大小无效")?;
        if total > MAX_TOTAL_BYTES || entry.size() > MAX_ENTRY_BYTES {
            return Err("EPUB 解压大小超出阅读上限（总计 500 MB、单项 50 MB）".into());
        }
        if entry.size() > 1024 * 1024 && entry.size() / entry.compressed_size().max(1) > 1000 {
            return Err("EPUB 压缩比例异常，已停止读取".into());
        }
        if !entry.is_dir() {
            entries.insert(
                name.to_owned(),
                Entry {
                    index,
                    size: entry.size(),
                },
            );
        }
    }
    Ok(entries)
}

fn read_bytes<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entries: &HashMap<String, Entry>,
    name: &str,
    maximum: u64,
) -> Result<Vec<u8>, String> {
    let entry = entries.get(name).ok_or("EPUB 缺少目录中引用的正文或图片")?;
    if entry.size > maximum {
        return Err("EPUB 单项内容超过阅读上限，已停止读取".into());
    }
    let mut file = archive
        .by_index(entry.index)
        .map_err(|_| "无法读取 EPUB 内容")?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "EPUB 内容损坏或校验失败")?;
    if bytes.len() as u64 != entry.size || bytes.len() as u64 > maximum {
        return Err("EPUB 内容长度无效，已停止读取".into());
    }
    Ok(bytes)
}

fn read_string<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entries: &HashMap<String, Entry>,
    name: &str,
    maximum: u64,
) -> Result<String, String> {
    let bytes = read_bytes(archive, entries, name, maximum)?;
    String::from_utf8(bytes).map_err(|_| "EPUB 内容不是 UTF-8 编码，暂不支持此电子书".into())
}

fn read_xml<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entries: &HashMap<String, Entry>,
    path: &str,
) -> Result<Element, String> {
    parse_xml(&read_string(archive, entries, path, MAX_XML_BYTES)?)
}

fn parse_xml(xml: &str) -> Result<Element, String> {
    let mut reader = Reader::from_str(xml.trim_start_matches('\u{feff}'));
    let mut stack = vec![Element::default()];
    let mut nodes = 0_usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| "EPUB XML/XHTML 内容损坏，已停止读取")?;
        nodes += 1;
        if nodes > 400_000 {
            return Err("EPUB 页面结构过于复杂，已停止读取".into());
        }
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(start) | Event::Empty(start) => {
                if stack.len() > 128 {
                    return Err("EPUB 页面结构过于复杂，已停止读取".into());
                }
                let name = String::from_utf8(start.local_name().as_ref().to_vec())
                    .map_err(|_| "EPUB 标签编码无效")?
                    .to_ascii_lowercase();
                let mut attributes = HashMap::new();
                for attribute in start.attributes() {
                    let attribute = attribute.map_err(|_| "EPUB 标签属性无效")?;
                    let key = String::from_utf8(attribute.key.as_ref().to_vec())
                        .map_err(|_| "EPUB 属性编码无效")?
                        .to_ascii_lowercase();
                    // `xml:base` can silently redirect every relative image.
                    if key == "xml:base" {
                        return Err("EPUB 不支持改变资源根目录的 xml:base 属性".into());
                    }
                    let key = if key == "xlink:href" {
                        "href".to_owned()
                    } else {
                        key
                    };
                    let value = attribute
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|_| "EPUB 属性文本无效")?
                        .into_owned();
                    if attributes.insert(key, value).is_some() {
                        return Err("EPUB 属性重复，已停止读取".into());
                    }
                }
                let element = Element {
                    name,
                    attributes,
                    children: Vec::new(),
                };
                if empty {
                    stack
                        .last_mut()
                        .unwrap()
                        .children
                        .push(Node::Element(element));
                } else {
                    stack.push(element);
                }
            }
            Event::End(_) => {
                if stack.len() <= 1 {
                    return Err("EPUB 标签嵌套无效".into());
                }
                let element = stack.pop().unwrap();
                stack
                    .last_mut()
                    .unwrap()
                    .children
                    .push(Node::Element(element));
            }
            Event::Text(text) => {
                let text = text.decode().map_err(|_| "EPUB 文本编码无效")?.into_owned();
                if !text.is_empty() {
                    stack.last_mut().unwrap().children.push(Node::Text(text));
                }
            }
            Event::CData(text) => stack.last_mut().unwrap().children.push(Node::Text(
                text.decode().map_err(|_| "EPUB 文本编码无效")?.into_owned(),
            )),
            Event::GeneralRef(reference) => {
                let reference = reference.decode().map_err(|_| "EPUB 文本实体无效")?;
                let escaped = format!("&{reference};");
                let text = quick_xml::escape::unescape(&escaped)
                    .map_err(|_| "EPUB 包含无法识别的文本实体")?
                    .into_owned();
                stack.last_mut().unwrap().children.push(Node::Text(text));
            }
            Event::DocType(text) if text.contains(&b'[') => {
                return Err("EPUB 不支持自定义 XML 实体声明".into())
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("EPUB 标签未完整闭合".into());
    }
    let root = stack.pop().unwrap();
    let mut elements = Vec::new();
    for node in root.children {
        match node {
            Node::Element(element) => elements.push(element),
            Node::Text(text) if !text.trim().is_empty() => {
                return Err("EPUB XML 根节点外存在内容".into())
            }
            _ => {}
        }
    }
    if elements.len() != 1 {
        return Err("EPUB XML 缺少唯一根节点".into());
    }
    Ok(elements.pop().unwrap())
}

fn resolve_reference(base: &str, reference: &str) -> Result<String, String> {
    let reference = reference.split('#').next().unwrap_or("");
    if reference.is_empty() {
        return Err("EPUB 资源引用为空".into());
    }
    let mut bytes = Vec::with_capacity(reference.len());
    let input = reference.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            let value = input
                .get(index + 1..index + 3)
                .and_then(|digits| std::str::from_utf8(digits).ok())
                .and_then(|digits| u8::from_str_radix(digits, 16).ok())
                .ok_or("EPUB 资源路径编码无效")?;
            bytes.push(value);
            index += 3;
        } else {
            bytes.push(input[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(bytes).map_err(|_| "EPUB 资源路径编码无效")?;
    if decoded.starts_with('/')
        || decoded.contains(['\\', ':', '?', '#'])
        || decoded.chars().any(char::is_control)
    {
        return Err("EPUB 不支持远程资源、绝对路径或无效资源链接".into());
    }
    let mut parts = base
        .rsplit_once('/')
        .map(|(directory, _)| directory.split('/').collect::<Vec<_>>())
        .unwrap_or_default();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("EPUB 资源路径超出电子书范围".into());
                }
            }
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        return Err("EPUB 资源路径无效".into());
    }
    Ok(parts.join("/"))
}

fn collect_navigation(
    element: &Element,
    path: &str,
    labels: &mut HashMap<String, String>,
) -> Result<(), String> {
    if element.name == "navpoint" {
        if let (Some(label), Some(content)) = (element.child("navlabel"), element.child("content"))
        {
            if let Some(reference) = content.attribute("src") {
                let destination = resolve_reference(path, reference)?;
                let title = label.text();
                if !title.is_empty() {
                    labels.entry(destination).or_insert(title);
                }
            }
        }
    } else if element.name == "a" {
        if let Some(reference) = element
            .attribute("href")
            .filter(|value| !value.starts_with('#'))
        {
            let destination = resolve_reference(path, reference)?;
            let title = element.text();
            if !title.is_empty() {
                labels.entry(destination).or_insert(title);
            }
        }
    }
    for child in &element.children {
        if let Node::Element(child) = child {
            collect_navigation(child, path, labels)?;
        }
    }
    Ok(())
}

fn first_heading(element: &Element) -> Option<String> {
    if matches!(
        element.name.as_str(),
        "script" | "style" | "iframe" | "object" | "embed"
    ) {
        return None;
    }
    if is_heading(&element.name) {
        let title = element.text();
        if !title.is_empty() {
            return Some(title);
        }
    }
    element.children.iter().find_map(|child| match child {
        Node::Element(child) => first_heading(child),
        _ => None,
    })
}

fn is_heading(name: &str) -> bool {
    matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}
fn bounded_chapter_title(value: &str) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > 1_000 {
                return false;
            }
            units = next;
            true
        })
        .collect()
}
fn is_boundary(name: &str) -> bool {
    matches!(
        name,
        "p" | "div" | "section" | "article" | "li" | "blockquote" | "pre" | "table" | "tr" | "hr"
    )
}
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_block(book: &mut EpubBook, block: EpubBlock, text_bytes: &mut usize) -> Result<(), String> {
    *text_bytes = text_bytes
        .checked_add(block.text.len())
        .ok_or("EPUB 文本大小无效")?;
    if *text_bytes > MAX_TEXT_BYTES || book.blocks.len() >= MAX_BLOCKS {
        return Err("EPUB 正文超过阅读上限（20 MB 或 40000 个段落）".into());
    }
    book.blocks.push(block);
    Ok(())
}

struct Renderer<'a, R: Read + Seek> {
    archive: &'a mut zip::ZipArchive<R>,
    entries: &'a HashMap<String, Entry>,
    path: &'a str,
    book: &'a mut EpubBook,
    image_numbers: &'a mut HashMap<String, usize>,
    text_bytes: &'a mut usize,
    pending: String,
    skip_heading: Option<String>,
    meaningful: bool,
}

impl<R: Read + Seek> Renderer<'_, R> {
    fn flush(&mut self, heading: bool) -> Result<(), String> {
        let text = std::mem::take(&mut self.pending)
            .split('\n')
            .map(collapse_whitespace)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned();
        if text.is_empty() {
            return Ok(());
        }
        if heading && !self.meaningful && self.skip_heading.as_deref() == Some(&text) {
            self.skip_heading = None;
            return Ok(());
        }
        self.meaningful = true;
        push_block(
            self.book,
            EpubBlock {
                text,
                heading,
                image_index: None,
            },
            self.text_bytes,
        )
    }

    fn children(&mut self, element: &Element) -> Result<(), String> {
        for child in &element.children {
            match child {
                // XML layout whitespace behaves like ordinary HTML spaces;
                // explicit <br> below remains an intentional line break.
                Node::Text(text) => self
                    .pending
                    .push_str(&text.replace(['\r', '\n', '\t'], " ")),
                Node::Element(child) => self.element(child)?,
            }
        }
        Ok(())
    }

    fn element(&mut self, element: &Element) -> Result<(), String> {
        let name = element.name.as_str();
        if matches!(
            name,
            "script"
                | "style"
                | "iframe"
                | "object"
                | "embed"
                | "audio"
                | "video"
                | "rt"
                | "rp"
                | "noscript"
        ) {
            return Ok(());
        }
        if name == "base" {
            return Err("EPUB 不支持改变资源根目录的 base 标签".into());
        }
        if name == "img" || name == "image" {
            self.flush(false)?;
            let reference = element
                .attribute(if name == "img" { "src" } else { "href" })
                .ok_or("EPUB 插图缺少资源地址")?;
            let path = resolve_reference(self.path, reference)?;
            let image_index = if let Some(index) = self.image_numbers.get(&path) {
                *index
            } else {
                if self.book.images.len() >= MAX_IMAGES {
                    return Err("EPUB 插图超过 1000 张，已停止读取".into());
                }
                let bytes = read_bytes(self.archive, self.entries, &path, MAX_ENTRY_BYTES)?;
                if ImageFormat::detect(&bytes).is_none() {
                    return Err("EPUB 插图不是支持的原始位图（JPG、PNG、WEBP、GIF、AVIF）".into());
                }
                let entry = self.entries.get(&path).ok_or("EPUB 插图缺失")?;
                let index = self.book.images.len();
                self.book.images.push(EpubImage {
                    index: entry.index,
                    name: path.clone(),
                    size: entry.size,
                });
                self.image_numbers.insert(path, index);
                index
            };
            push_block(
                self.book,
                EpubBlock {
                    text: element.attribute("alt").unwrap_or("").to_owned(),
                    heading: false,
                    image_index: Some(image_index),
                },
                self.text_bytes,
            )?;
            self.meaningful = true;
            return Ok(());
        }
        if name == "br" {
            self.pending.push('\n');
            return Ok(());
        }
        let boundary = is_boundary(name) || is_heading(name);
        if boundary {
            self.flush(false)?;
        }
        self.children(element)?;
        if boundary {
            self.flush(is_heading(name))?;
        }
        Ok(())
    }
}

fn preflight(file: &mut File) -> Result<(), String> {
    let size = file.metadata().map_err(|_| "无法读取 EPUB 文件信息")?.len();
    if size > MAX_ARCHIVE_BYTES {
        return Err("EPUB 超过 512 MB，请使用系统阅读器打开".into());
    }
    let tail_size = size.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(|_| "无法读取 EPUB 目录")?;
    let mut tail = vec![0_u8; tail_size];
    file.read_exact(&mut tail)
        .map_err(|_| "无法读取 EPUB 目录")?;
    let eocd = tail
        .windows(4)
        .rposition(|bytes| bytes == b"PK\x05\x06")
        .ok_or("EPUB 缺少有效 ZIP 目录，或文件已损坏")?;
    if eocd + 22 > tail.len() {
        return Err("EPUB ZIP 目录不完整".into());
    }
    let entries_here = u16::from_le_bytes(tail[eocd + 8..eocd + 10].try_into().unwrap()) as usize;
    let entries_total = u16::from_le_bytes(tail[eocd + 10..eocd + 12].try_into().unwrap()) as usize;
    let central_size = u32::from_le_bytes(tail[eocd + 12..eocd + 16].try_into().unwrap());
    let central_offset = u32::from_le_bytes(tail[eocd + 16..eocd + 20].try_into().unwrap());
    let comment_size = u16::from_le_bytes(tail[eocd + 20..eocd + 22].try_into().unwrap()) as usize;
    if eocd + 22 + comment_size != tail.len() {
        return Err("EPUB ZIP 目录或注释长度无效".into());
    }
    if entries_here == u16::MAX as usize
        || entries_total == u16::MAX as usize
        || central_size == u32::MAX
        || central_offset == u32::MAX
        || eocd >= 20 && &tail[eocd - 20..eocd - 16] == b"PK\x06\x07"
    {
        return Err("EPUB ZIP64 目录暂不支持".into());
    }
    if tail[eocd + 4..eocd + 8] != [0, 0, 0, 0] || entries_here != entries_total {
        return Err("应用内阅读不支持分卷 EPUB".into());
    }
    if entries_total > MAX_ENTRIES
        || central_size > 8 * 1024 * 1024
        || u64::from(central_offset) + u64::from(central_size)
            > size - tail_size as u64 + eocd as u64
    {
        return Err("EPUB ZIP 目录大小或条目数量无效".into());
    }
    // zip's public index collapses duplicate names. Check the bounded raw
    // central directory first so two entries cannot silently select a different
    // OPF, chapter or image in another reader.
    file.seek(SeekFrom::Start(u64::from(central_offset)))
        .map_err(|_| "无法定位 EPUB ZIP 目录")?;
    let mut central = vec![0_u8; central_size as usize];
    file.read_exact(&mut central)
        .map_err(|_| "EPUB ZIP 目录不完整")?;
    let mut offset = 0;
    let mut names = HashSet::new();
    for _ in 0..entries_total {
        let header = central
            .get(offset..offset + 46)
            .ok_or("EPUB ZIP 目录条目不完整")?;
        if &header[..4] != b"PK\x01\x02" {
            return Err("EPUB ZIP 目录条目无效".into());
        }
        let flags = u16::from_le_bytes(header[8..10].try_into().unwrap());
        if flags & 1 != 0 {
            return Err("应用内阅读不支持加密 EPUB".into());
        }
        let name_size = u16::from_le_bytes(header[28..30].try_into().unwrap()) as usize;
        let extra_size = u16::from_le_bytes(header[30..32].try_into().unwrap()) as usize;
        let comment_size = u16::from_le_bytes(header[32..34].try_into().unwrap()) as usize;
        let name = central
            .get(offset + 46..offset + 46 + name_size)
            .ok_or("EPUB ZIP 路径不完整")?;
        let name = std::str::from_utf8(name).map_err(|_| "EPUB ZIP 路径不是 UTF-8 编码")?;
        if !names.insert(name) {
            return Err("EPUB 包含重复归档路径，无法确定正文".into());
        }
        let extra_start = offset + 46 + name_size;
        let extra = central
            .get(extra_start..extra_start + extra_size)
            .ok_or("EPUB ZIP 扩展目录不完整")?;
        validate_extra_name(name, extra)?;
        offset += 46 + name_size + extra_size + comment_size;
        if offset > central.len() {
            return Err("EPUB ZIP 目录条目长度无效".into());
        }
    }
    if offset != central.len() {
        return Err("EPUB ZIP 目录条目数量不匹配".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "无法定位 EPUB 文件")?;
    Ok(())
}

fn validate_extra_name(name: &str, mut extra: &[u8]) -> Result<(), String> {
    while !extra.is_empty() {
        if extra.len() < 4 {
            return Err("EPUB ZIP 扩展目录无效".into());
        }
        let tag = u16::from_le_bytes(extra[..2].try_into().unwrap());
        let size = u16::from_le_bytes(extra[2..4].try_into().unwrap()) as usize;
        let value = extra.get(4..4 + size).ok_or("EPUB ZIP 扩展目录长度无效")?;
        // EPUB uses UTF-8 file names already. A conflicting Info-ZIP Unicode
        // override could otherwise collapse distinct raw central-directory
        // names inside ZipArchive before inspect_entries sees them.
        if tag == 0x7075 && (value.len() < 5 || value[0] != 1 || value[5..] != *name.as_bytes()) {
            return Err("EPUB ZIP Unicode 路径与目录不一致，无法确定正文".into());
        }
        extra = &extra[4 + size..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\noriginal-image-bytes";
    const CONTAINER: &[u8] = br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "acgn-epub-test-{}-{stamp}-{}",
                std::process::id(),
                FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn archive(&self, entries: &[(&str, &[u8])]) -> PathBuf {
            let path = self.0.join("book.epub");
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, bytes) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
            path
        }
        fn book(&self, opf: &str, extra: &[(&str, &[u8])]) -> Result<EpubBook, String> {
            let mut entries = vec![
                ("mimetype", b"application/epub+zip".as_slice()),
                ("META-INF/container.xml", CONTAINER),
                ("OEBPS/book.opf", opf.as_bytes()),
            ];
            entries.extend_from_slice(extra);
            read_epub(&mut File::open(self.archive(&entries)).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn package(manifest: &str, spine: &str) -> String {
        format!("<package><manifest>{manifest}</manifest><spine>{spine}</spine></package>")
    }
    fn single_package() -> String {
        package(
            r#"<item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="a"/>"#,
        )
    }

    #[test]
    fn reads_spine_order_and_native_chapter_titles_without_guessing_filename_order() {
        let fixture = Fixture::new();
        let opf = package(
            r#"<item id="first" href="Text/10.xhtml" media-type="application/xhtml+xml"/><item id="second" href="Text/2.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="second"/><itemref idref="first"/>"#,
        );
        let book = fixture.book(&opf, &[("OEBPS/Text/10.xhtml", "<html><head><title>任意章节名</title></head><body><p>末章正文</p></body></html>".as_bytes()),
            ("OEBPS/Text/2.xhtml", "<html><body><h1>一切的开始</h1><p>第一段<em>连续文本</em>。</p><p>第二段。</p></body></html>".as_bytes())]).unwrap();
        assert_eq!(
            book.chapters
                .iter()
                .map(|chapter| chapter.title.as_str())
                .collect::<Vec<_>>(),
            ["一切的开始", "任意章节名"]
        );
        assert_eq!(book.chapters[0].block_index, 0);
        assert_eq!(book.chapters[1].block_index, 3);
        assert_eq!(
            book.blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<Vec<_>>(),
            [
                "一切的开始",
                "第一段连续文本。",
                "第二段。",
                "任意章节名",
                "末章正文"
            ]
        );
    }

    #[test]
    fn bounds_navigation_titles_to_the_ipc_utf16_limit_without_truncating_body_text() {
        let fixture = Fixture::new();
        let long_title = format!("{}😀末", "章".repeat(999));
        let body = format!(
            "<html><head><title>{long_title}</title></head><body><p>正文完整保留</p></body></html>"
        );
        let book = fixture
            .book(
                &single_package(),
                &[("OEBPS/Text/a.xhtml", body.as_bytes())],
            )
            .unwrap();
        assert_eq!(book.chapters[0].title.encode_utf16().count(), 999);
        assert_eq!(book.blocks[0].text, book.chapters[0].title);
        assert_eq!(book.blocks[1].text, "正文完整保留");
        assert!(!book.chapters[0].title.contains('\u{fffd}'));
    }

    #[test]
    fn retains_interleaved_original_images_and_uses_opaque_image_positions() {
        let fixture = Fixture::new();
        let body = r#"<html><head><title>Illustrations</title></head><body><p>Before</p><img src="../Images/one%20image.png" alt="插图"/><p>Between</p><img src="../Images/one%20image.png"/><p>After</p></body></html>"#;
        let book = fixture
            .book(
                &single_package(),
                &[
                    ("OEBPS/Images/one image.png", PNG),
                    ("OEBPS/Text/a.xhtml", body.as_bytes()),
                ],
            )
            .unwrap();
        assert_eq!(book.images.len(), 1);
        assert_eq!(book.images[0].name, "OEBPS/Images/one image.png");
        assert_eq!(book.images[0].size, PNG.len() as u64);
        assert_eq!(book.images[0].index, 3);
        assert_eq!(
            book.blocks
                .iter()
                .filter_map(|block| block.image_index)
                .collect::<Vec<_>>(),
            [0, 0]
        );
        assert_eq!(book.blocks[2].text, "插图");
        let json = serde_json::to_value(&book).unwrap();
        assert!(json["blocks"][0].get("imageIndex").is_none());
        assert_eq!(json["blocks"][2]["imageIndex"], 0);
    }

    #[test]
    fn ignores_script_css_embedded_objects_ruby_readings_and_renders_escaped_markup_as_data() {
        let fixture = Fixture::new();
        let body = r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "https://example.invalid/never-fetch.dtd"><html lang="zh" xml:lang="zh"><head><title>安全文本</title><style>hidden{}</style></head><body><script>bad()</script><style>bad()</style><iframe src="https://example.invalid">bad frame</iframe><p>&lt;script&gt;literal&lt;/script&gt;&nbsp;&#20013;<ruby>正文<rt>注音</rt><rp>(</rp></ruby><a href="https://example.invalid">普通链接文字</a></p></body></html>"#;
        let book = fixture
            .book(
                &single_package(),
                &[("OEBPS/Text/a.xhtml", body.as_bytes())],
            )
            .unwrap();
        assert_eq!(
            book.blocks[1].text,
            "<script>literal</script> 中正文普通链接文字"
        );
        assert!(!book.blocks.iter().any(|block| block.text.contains("bad")));
    }

    #[test]
    fn keeps_explicit_poetry_line_breaks_without_treating_xml_indentation_as_paragraphs() {
        let fixture = Fixture::new();
        let book = fixture
            .book(
                &single_package(),
                &[(
                    "OEBPS/Text/a.xhtml",
                    b"<html><body>\n  <p>First <em>line</em><br/>Second line</p>\n</body></html>",
                )],
            )
            .unwrap();
        assert_eq!(book.blocks[1].text, "First line\nSecond line");
    }

    #[test]
    fn uses_epub_navigation_labels_and_skips_non_linear_supplements() {
        let fixture = Fixture::new();
        let opf = package(
            r#"<item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/><item id="extra" href="Text/missing.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="a"/><itemref idref="extra" linear="no"/>"#,
        );
        let book = fixture.book(&opf, &[("OEBPS/Text/a.xhtml", b"<html><body><p>Real text</p></body></html>"),
            ("OEBPS/nav.xhtml", "<html><body><nav><a href=\"Text/a.xhtml#start\">原书任意章名</a></nav></body></html>".as_bytes())]).unwrap();
        assert_eq!(book.chapters[0].title, "原书任意章名");
        assert_eq!(book.chapters.len(), 1);
    }

    #[test]
    fn supports_ncx_labels_and_bom_but_never_resolves_external_entities() {
        let fixture = Fixture::new();
        let opf = package(
            r#"<item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#,
            r#"<itemref idref="a"/>"#,
        );
        let book = fixture.book(&opf, &[("OEBPS/Text/a.xhtml", "\u{feff}<html><body><p>正文</p></body></html>".as_bytes()),
            ("OEBPS/toc.ncx", "<ncx><navMap><navPoint><navLabel><text>序幕</text></navLabel><content src=\"Text/a.xhtml\"/></navPoint></navMap></ncx>".as_bytes())]).unwrap();
        assert_eq!(book.chapters[0].title, "序幕");
        assert!(parse_xml(r#"<!DOCTYPE html [<!ENTITY leak SYSTEM "file:///private">]><html><body>&leak;</body></html>"#).unwrap_err().contains("实体"));
    }

    #[test]
    fn rejects_path_escapes_remote_images_and_resource_bases() {
        for reference in [
            "../../../private.png",
            "https://example.invalid/image.png",
            "//example.invalid/image.png",
            "file:///private.png",
            "..%2f..%2f..%2fprivate.png",
            "..%5cprivate.png",
            "../Images/a.png?token=foo",
            "../Images/%00.png",
        ] {
            let fixture = Fixture::new();
            let body = format!("<html><body><img src=\"{reference}\"/></body></html>");
            assert!(
                fixture
                    .book(
                        &single_package(),
                        &[("OEBPS/Text/a.xhtml", body.as_bytes())]
                    )
                    .is_err(),
                "{reference}"
            );
        }
        let fixture = Fixture::new();
        assert!(fixture
            .book(
                &single_package(),
                &[(
                    "OEBPS/Text/a.xhtml",
                    b"<html xml:base='https://example.invalid/'><body><p>Text</p></body></html>"
                )]
            )
            .unwrap_err()
            .contains("xml:base"));
        assert!(fixture
            .book(
                &single_package(),
                &[(
                    "OEBPS/Text/a.xhtml",
                    b"<html><body><base href='https://example.invalid/'/><p>Text</p></body></html>"
                )]
            )
            .unwrap_err()
            .contains("base"));
    }

    #[test]
    fn refuses_drm_encryption_traversal_entries_and_duplicate_paths() {
        let fixture = Fixture::new();
        let body = b"<html><body><p>Text</p></body></html>";
        for extra in [
            "META-INF/encryption.xml",
            "META-INF/rights.xml",
            "../outside.txt",
        ] {
            let error = fixture
                .book(
                    &single_package(),
                    &[("OEBPS/Text/a.xhtml", body), (extra, b"protected")],
                )
                .unwrap_err();
            assert!(error.contains("DRM") || error.contains("路径"), "{error}");
        }
        // ZIP writers prohibit duplicate names; mutate one same-length central
        // and local name to model a malformed archive from outside the app.
        let path = fixture.archive(&[
            ("mimetype", b"application/epub+zip"),
            ("a.txt", b"a"),
            ("b.txt", b"b"),
        ]);
        let bytes = std::fs::read(&path).unwrap();
        let mut bytes = bytes;
        for index in 0..bytes.len() - 5 {
            if &bytes[index..index + 5] == b"b.txt" {
                bytes[index] = b'a';
            }
        }
        std::fs::write(&path, bytes).unwrap();
        assert!(read_epub(&mut File::open(path).unwrap())
            .unwrap_err()
            .contains("重复"));
    }

    #[test]
    fn rejects_missing_wrong_or_repeated_spine_identities_and_fake_images() {
        let fixture = Fixture::new();
        for opf in [
            package(
                r#"<item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>"#,
                r#"<itemref idref="missing"/>"#,
            ),
            package(
                r#"<item id="a" href="Text/a.xhtml" media-type="image/svg+xml"/>"#,
                r#"<itemref idref="a"/>"#,
            ),
            package(
                r#"<item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>"#,
                r#"<itemref idref="a"/><itemref idref="a"/>"#,
            ),
        ] {
            assert!(fixture
                .book(
                    &opf,
                    &[(
                        "OEBPS/Text/a.xhtml",
                        b"<html><body><p>Text</p></body></html>"
                    )]
                )
                .is_err());
        }
        assert!(fixture
            .book(
                &single_package(),
                &[
                    (
                        "OEBPS/Text/a.xhtml",
                        b"<html><body><img src='../Images/fake.png'/></body></html>"
                    ),
                    ("OEBPS/Images/fake.png", b"<html>error page</html>")
                ]
            )
            .unwrap_err()
            .contains("位图"));
        assert!(fixture
            .book(
                &single_package(),
                &[
                    (
                        "OEBPS/Text/a.xhtml",
                        b"<html><body><img src='../Images/vector.svg'/></body></html>"
                    ),
                    ("OEBPS/Images/vector.svg", b"<svg onload='bad()'/>")
                ]
            )
            .unwrap_err()
            .contains("位图"));
    }

    #[test]
    fn refuses_corrupt_invalid_utf8_and_truncated_xml_instead_of_silently_shortening_text() {
        let fixture = Fixture::new();
        for body in [
            b"<html><body><p>cut off".as_slice(),
            b"<html><body><p>\xff</p></body></html>",
            b"<html><body><p>Text</div></body></html>",
        ] {
            assert!(fixture
                .book(&single_package(), &[("OEBPS/Text/a.xhtml", body)])
                .is_err());
        }
        assert!(fixture
            .book(
                &single_package(),
                &[(
                    "OEBPS/Text/a.xhtml",
                    b"<html><body><h1>Only a title</h1></body></html>"
                )]
            )
            .unwrap_err()
            .contains("没有可阅读"));
        let path = fixture.archive(&[("mimetype", b"application/epub+zip")]);
        std::fs::write(&path, b"not an EPUB").unwrap();
        assert!(read_epub(&mut File::open(&path).unwrap())
            .unwrap_err()
            .contains("损坏"));
    }

    #[test]
    fn rejects_a_chapter_whose_zip_crc_no_longer_matches_its_text() {
        let fixture = Fixture::new();
        let opf = single_package();
        let path = fixture.archive(&[
            ("mimetype", b"application/epub+zip"),
            ("META-INF/container.xml", CONTAINER),
            ("OEBPS/book.opf", opf.as_bytes()),
            (
                "OEBPS/Text/a.xhtml",
                b"<html><body><p>Original prose</p></body></html>",
            ),
        ]);
        let mut bytes = std::fs::read(&path).unwrap();
        let position = bytes
            .windows(14)
            .position(|bytes| bytes == b"Original prose")
            .unwrap();
        bytes[position] = b'X';
        std::fs::write(&path, bytes).unwrap();
        assert!(read_epub(&mut File::open(path).unwrap())
            .unwrap_err()
            .contains("校验失败"));
    }

    #[test]
    fn bounds_archive_directory_xml_complexity_and_rendered_blocks() {
        let fixture = Fixture::new();
        let path = fixture.archive(&[("mimetype", b"application/epub+zip")]);
        let mut bytes = std::fs::read(&path).unwrap();
        let eocd = bytes
            .windows(4)
            .rposition(|bytes| bytes == b"PK\x05\x06")
            .unwrap();
        bytes[eocd + 8..eocd + 10].copy_from_slice(&((MAX_ENTRIES + 1) as u16).to_le_bytes());
        bytes[eocd + 10..eocd + 12].copy_from_slice(&((MAX_ENTRIES + 1) as u16).to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        assert!(read_epub(&mut File::open(&path).unwrap()).is_err());
        let nested = format!("{}{}", "<div>".repeat(130), "</div>".repeat(130));
        assert!(parse_xml(&nested).unwrap_err().contains("复杂"));
        let body = format!(
            "<html><body>{}</body></html>",
            "<p>Text</p>".repeat(MAX_BLOCKS)
        );
        assert!(fixture
            .book(
                &single_package(),
                &[("OEBPS/Text/a.xhtml", body.as_bytes())]
            )
            .unwrap_err()
            .contains("40000"));
    }

    #[test]
    fn rejects_conflicting_unicode_zip_path_overrides_before_archive_name_deduplication() {
        // Extra field 0x7075, payload version + CRC + UTF-8 path.
        let valid = [
            0x75, 0x70, 10, 0, 1, 0, 0, 0, 0, b'a', b'.', b't', b'x', b't',
        ];
        assert!(validate_extra_name("a.txt", &valid).is_ok());
        assert!(validate_extra_name("b.txt", &valid)
            .unwrap_err()
            .contains("Unicode"));
        assert!(validate_extra_name("a.txt", &valid[..8]).is_err());
    }

    #[test]
    #[ignore = "uses an explicitly supplied local source EPUB; never downloads during tests"]
    fn verifies_real_local_source_epub() {
        let path = std::env::var("ACGN_EPUB_TEST_FILE")
            .expect("set ACGN_EPUB_TEST_FILE to a verified local EPUB fixture");
        let book = read_epub(&mut File::open(path).unwrap()).unwrap();
        let text_bytes = book
            .blocks
            .iter()
            .map(|block| block.text.len())
            .sum::<usize>();
        assert!(text_bytes > 1000);
        assert!(book.chapters.len() > 1);
        assert!(!book.images.is_empty());
        println!(
            "real EPUB verified: blocks={} chapters={} images={} textBytes={text_bytes}",
            book.blocks.len(),
            book.chapters.len(),
            book.images.len()
        );
    }
}
