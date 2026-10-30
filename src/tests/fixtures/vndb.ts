export const vndbSearchFixture = {
  results: [
    {
      id: "v17",
      title: "Fate/stay night",
      alttitle: "フェイト／ステイナイト",
      titles: [
        { title: "Fate/stay night", latin: "Fate/stay night", lang: "en", official: true, main: false },
        { title: "フェイト／ステイナイト", latin: "Fate/stay night", lang: "ja", official: true, main: true },
      ],
      aliases: ["FSN"],
      olang: "ja",
      released: "2004-01-30",
      languages: ["ja", "en"],
      platforms: ["win", "ps2"],
      image: {
        url: "https://s.vndb.org/v17/0f/17.jpg",
        thumbnail: "https://t.vndb.org/v17/0f/17.jpg",
      },
      description: "聖杯戦争をめぐるビジュアルノベル。",
      rating: 88,
      votecount: 1000,
    },
  ],
  more: false,
};

export const vndbDetailFixture = vndbSearchFixture.results[0];

export const vndbDetailsFixture = {
  ...vndbDetailFixture,
  description: "[url=/v17]Fate/stay night[/url] は聖杯戦争をめぐる物語。[spoiler]隠された真実[/spoiler]",
  length_minutes: 3000,
  tags: [
    { name: "Fantasy", rating: 2.4, spoiler: 0, lie: false },
    { name: "Holy Grail War", rating: 1.8, spoiler: 0, lie: false },
    { name: "Big Twist", rating: 3.0, spoiler: 2, lie: false },
  ],
  developers: [{ name: "TYPE-MOON", original: null }],
  staff: [
    { name: "Nasu Kinoko", original: "奈須きのこ", role: "scenario" },
    { name: "Takeuchi Takashi", original: null, role: "art" },
    { name: "Kate", original: null, role: "unknown_role" },
  ],
};

export const vndbCharactersFixture = {
  results: [
    { id: "c1", name: "Saber", original: "セイバー", vns: [{ role: "main" }] },
    { id: "c2", name: "Rin Tohsaka", original: null, vns: [{ role: "primary" }] },
    { id: "c3", name: "Shirou Emiya", original: null, vns: [] },
  ],
  more: false,
};
