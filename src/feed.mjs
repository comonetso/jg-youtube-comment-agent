// 지정 채널의 최신 영상 목록 — 채널 RSS(키 불필요).
const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const pick = (block, re) => (block.match(re) || [])[1];

export async function fetchChannelVideos(channel) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  const res = await fetch(url, { headers: { 'accept-language': 'ko-KR,ko;q=0.9' } });
  if (!res.ok) throw new Error(`${channel.name}: 목록 요청 실패 (HTTP ${res.status})`);
  const xml = await res.text();
  const entries = xml.split('<entry>').slice(1);
  return entries.map((e) => {
    const videoId = pick(e, /<yt:videoId>([^<]+)<\/yt:videoId>/);
    return {
      videoId,
      title: decode(pick(e, /<title>([^<]*)<\/title>/) || ''),
      channelId: pick(e, /<yt:channelId>([^<]+)<\/yt:channelId>/) || channel.id,
      channelName: channel.name,
      publishedAt: pick(e, /<published>([^<]+)<\/published>/),
      thumbnail: pick(e, /<media:thumbnail url="([^"]+)"/) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views: Number(pick(e, /<media:statistics views="(\d+)"/) || 0),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}

// 라이브 방송은 댓글 대신 채팅이라 게시 단계에서 막힌다(post.mjs). RSS 에는 라이브 여부가 없어
// 실측한 제목 모양("Live streaming of …", 2026-10-19 리즈시절 LizTV)으로 걸러 목록에서 뺀다.
const LIVE_TITLE_RE = /^live streaming of /i;

/** 모든 지정 채널의 영상을 모아 최신순으로. 실패한 채널은 errors, 뺀 라이브 수는 skippedLive. */
export async function fetchLatestVideos(channels, { perChannel = 15 } = {}) {
  const results = await Promise.allSettled(channels.map((c) => fetchChannelVideos(c)));
  const videos = [];
  const errors = [];
  let skippedLive = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return errors.push({ channel: channels[i].name, message: r.reason.message });
    for (const v of r.value.slice(0, perChannel)) {
      if (LIVE_TITLE_RE.test(v.title)) skippedLive++;
      else videos.push(v);
    }
  });
  videos.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return { videos, errors, skippedLive };
}
