export const bangumiSearchFixture = {
  total: 1,
  limit: 20,
  offset: 0,
  data: [
    {
      id: 12345,
      type: 2,
      name: "葬送のフリーレン",
      name_cn: "葬送的芙莉莲",
      summary: "魔法使芙莉莲的旅途。",
      date: "2023-09-29",
      platform: "TV",
      images: {
        large: "https://lain.bgm.tv/pic/cover/l/aa/bb/12345_abc.jpg",
        medium: "https://lain.bgm.tv/pic/cover/m/aa/bb/12345_abc.jpg",
      },
      tags: [],
      rating: { score: 8.8 },
      collection: { doing: 100 },
    },
  ],
};

export const bangumiDetailFixture = bangumiSearchFixture.data[0];

export const bangumiDetailsFixture = {
  id: 12345,
  type: 2,
  name: "葬送のフリーレン",
  name_cn: "葬送的芙莉莲",
  summary: "魔法使芙莉莲的旅途。",
  date: "2023-09-29",
  platform: "TV",
  images: {
    large: "https://lain.bgm.tv/pic/cover/l/aa/bb/12345_abc.jpg",
    medium: "https://lain.bgm.tv/pic/cover/m/aa/bb/12345_abc.jpg",
  },
  infobox: [
    { key: "话数", value: "28" },
    { key: "放送开始", value: "2023-09-29" },
    { key: "制作公司", value: "MADHOUSE" },
  ],
  tags: [
    { name: "奇幻", count: 800 },
    { name: "冒险", count: 500 },
    { name: "MADHOUSE", count: 120 },
  ],
  rating: { score: 8.8, total: 4200 },
};

export const bangumiCharactersFixture = [
  { id: 1, name: "芙莉莲", role: "main", actors: [{ id: 11, name: "种崎敦美" }] },
  { id: 2, name: "菲伦", role: "support", actors: [{ id: 12, name: "市之濑加那" }] },
];

export const bangumiPersonsFixture = [
  { id: 21, name: "斋藤圭一郎", relation: "导演" },
  { id: 22, name: "种崎敦美", originalName: null, relation: "角色原案" },
];
