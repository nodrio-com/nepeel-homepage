import type { Post } from "../../shared/types";

interface EditorialItem {
  id: string;
  title: string;
  category: string;
  caption: string;
  creator?: string;
  sourceUrl: string;
  media: { type: "photo"; url: string } | { type: "video"; url: string; poster: string };
}

const selection: EditorialItem[] = [
  {
    id: "sample-concert",
    title: "멜트 페스티벌의 밤",
    category: "공연",
    caption: "무대에서 뻗은 노란 조명이 관객의 머리 위를 가른다.",
    creator: "Yvette de Wit",
    sourceUrl: "https://unsplash.com/photos/NYrVisodQ2M",
    media: { type: "photo", url: "/images/concert.webp" },
  },
  {
    id: "sample-skate",
    title: "노란 레일을 넘어서",
    category: "스케이트보드",
    caption: "스케이터가 레일 위로 몸을 띄웠다가 바닥에 착지한다.",
    creator: "Italo Bicca",
    sourceUrl: "https://www.pexels.com/video/skater-doing-tricks-on-a-skate-park-6553306/",
    media: { type: "video", url: "/images/skate.mp4", poster: "/images/skate.webp" },
  },
  {
    id: "sample-mong-kok",
    title: "몽콕의 저녁",
    category: "거리",
    caption: "홍콩 몽콕. 거리를 지나는 사람들 위로 간판이 겹겹이 걸려 있다.",
    creator: "Benh LIEU SONG",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Mong_Kok_Neon_Signs_Night_(48127904386).jpg",
    media: { type: "photo", url: "/images/mong-kok.webp" },
  },
  {
    id: "sample-pottery",
    title: "물레 위의 손",
    category: "공예",
    caption: "한 손은 안쪽에서, 다른 손은 바깥에서 흙을 받친다.",
    creator: "Piotrus",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Potter_in_Rabka_04.JPG",
    media: { type: "photo", url: "/images/pottery.webp" },
  },
  {
    id: "sample-road",
    title: "붉은 바위 사이로",
    category: "로드트립",
    caption: "두 줄의 노란 중앙선이 붉은 바위 틈으로 이어진다.",
    sourceUrl: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee",
    media: { type: "photo", url: "/images/roadtrip.webp" },
  },
  {
    id: "sample-portrait",
    title: "회색 배경의 초상",
    category: "인물",
    caption: "검은 셔츠를 입은 인물이 머리카락에 한 손을 댄 채 카메라를 본다.",
    creator: "Rafaella Mendes Diniz",
    sourceUrl: "https://unsplash.com/photos/et_78QkMMQs",
    media: { type: "photo", url: "/images/street-style.webp" },
  },
  {
    id: "sample-ocean",
    title: "파도가 남긴 선",
    category: "바다",
    caption: "오아후 노스쇼어의 저녁. 밀려온 파도가 모래 위에 얇은 흰 선을 그린다.",
    creator: "Sean Oulashin",
    sourceUrl: "https://unsplash.com/photos/KMn4VEeEPR8",
    media: { type: "photo", url: "/images/ocean.webp" },
  },
];

export const sampleMeta = selection.map(item => ({ ...item, tag: item.title }));
export const editorialTopics = [...new Set(selection.map(item => item.category))];

export function matchesEditorialSearch(post: Post, search: string) {
  if (!search) return true;
  const item = sampleMeta.find(sample => sample.id === post.id);
  return [post.caption, post.display_name, item?.title, item?.category, item?.creator]
    .join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

export const samplePosts: Post[] = selection.map(item => ({
  id: item.id,
  sample: true,
  caption: item.caption,
  media_type: item.media.type,
  image_url: item.media.url,
  ...(item.media.type === "video" ? { poster_url: item.media.poster } : {}),
  user_id: "",
  username: "",
  display_name: "에디터 픽",
  image_path: "",
  created_at: "",
  captured_at: "",
  like_count: 0,
  comment_count: 0,
  liked: false,
  saved: false,
  following: false,
}));
