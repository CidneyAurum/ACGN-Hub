export const rssFixture = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>ACGN Updates</title>
    <link>https://example.com/updates</link>
    <description>Latest releases</description>
    <item>
      <title>Episode 01</title>
      <link>https://example.com/episode-01</link>
      <guid isPermaLink="false">episode-01</guid>
      <pubDate>Mon, 17 Aug 2026 05:00:00 GMT</pubDate>
      <dc:creator>ACGN Team</dc:creator>
      <category>Anime</category>
      <category>1080p</category>
      <description><![CDATA[Episode description]]></description>
      <enclosure url="https://downloads.example.com/episode-01.mkv" length="2048" type="video/x-matroska" />
    </item>
  </channel>
</rss>`;

export const atomFixture = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Visual Novel Releases</title>
  <subtitle>Atom source</subtitle>
  <link href="https://example.com/releases" rel="alternate" />
  <entry>
    <id>tag:example.com,2026:release-01</id>
    <title>Release 01</title>
    <link href="https://example.com/release-01" rel="alternate" />
    <link href="https://downloads.example.com/release-01.zip" rel="enclosure" type="application/zip" length="4096" />
    <published>2026-08-17T06:00:00Z</published>
    <updated>2026-08-17T06:30:00Z</updated>
    <author><name>VN Team</name></author>
    <category term="visual-novel" />
    <summary>Release summary</summary>
  </entry>
</feed>`;
