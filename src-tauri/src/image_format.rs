/// Formats recognized from the response body, independent of URL or HTTP headers.
/// This verifies the file signature; it does not decode or repair damaged images.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImageFormat {
    Jpeg,
    Png,
    Gif,
    Webp,
    Avif,
}

impl ImageFormat {
    pub(crate) fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else if Self::has_avif_brand(bytes) {
            Some(Self::Avif)
        } else {
            None
        }
    }

    fn has_avif_brand(bytes: &[u8]) -> bool {
        if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
            return false;
        }
        let box_size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        if box_size < 16 || box_size > bytes.len() || (box_size - 16) % 4 != 0 {
            return false;
        }
        let is_avif = |brand: &[u8]| matches!(brand, b"avif" | b"avis");
        is_avif(&bytes[8..12]) || bytes[16..box_size].chunks_exact(4).any(is_avif)
    }

    pub(crate) fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Avif => "image/avif",
        }
    }

    pub(crate) fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Avif => "avif",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ImageFormat;

    #[test]
    fn detects_supported_image_signatures_and_canonical_extensions() {
        let cases: &[(&[u8], ImageFormat, &str, &str)] = &[
            (
                b"\xff\xd8\xff\xe0JPEG",
                ImageFormat::Jpeg,
                "image/jpeg",
                "jpg",
            ),
            (b"\x89PNG\r\n\x1a\n", ImageFormat::Png, "image/png", "png"),
            (b"GIF87a", ImageFormat::Gif, "image/gif", "gif"),
            (b"GIF89a", ImageFormat::Gif, "image/gif", "gif"),
            (
                b"RIFF\x04\x00\x00\x00WEBP",
                ImageFormat::Webp,
                "image/webp",
                "webp",
            ),
            (
                b"\x00\x00\x00\x14ftypavif\x00\x00\x00\x00mif1",
                ImageFormat::Avif,
                "image/avif",
                "avif",
            ),
            // AVIF may be a compatible brand rather than the major brand.
            (
                b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00miafavif",
                ImageFormat::Avif,
                "image/avif",
                "avif",
            ),
            (
                b"\x00\x00\x00\x14ftypavis\x00\x00\x00\x00mif1",
                ImageFormat::Avif,
                "image/avif",
                "avif",
            ),
        ];
        for (bytes, expected, mime, extension) in cases {
            let actual = ImageFormat::detect(bytes).unwrap();
            assert_eq!(actual, *expected);
            assert_eq!(actual.mime(), *mime);
            assert_eq!(actual.extension(), *extension);
        }
    }

    #[test]
    fn rejects_error_documents_empty_bodies_and_non_image_containers() {
        let errors: &[&[u8]] = &[
            b"",
            b"<!DOCTYPE html><html>Access denied</html>",
            b"\xef\xbb\xbf<html>Checking your browser</html>",
            b"{\"error\":\"hotlink denied\"}",
            b"Too many requests",
            b"\x89PNG",
            b"RIFF\x04\x00\x00\x00WAVE",
            b"\x00\x00\x00\x14ftypisom\x00\x00\x00\x00mp42",
            b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00avif", // Truncated box.
            b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00xavifxxx", // Unaligned brand.
        ];
        for bytes in errors {
            assert_eq!(ImageFormat::detect(bytes), None, "body={bytes:?}");
        }
    }
}
