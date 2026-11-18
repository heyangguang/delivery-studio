import React from "react";

/* The logos a component can wear. Every glyph is drawn in a 40×40 box in white on a tinted tile, in the same line
   weight as the rest of the interface. The ids here must equal mwpack.ComponentIcons / ComponentColors (a Go test
   compares them). */

const S = {
  fill: "none",
  stroke: "#fff",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
const F = { fill: "#fff", fillOpacity: 0.22 } as const;

export const ICONS: {
  id: string;
  label: string;
  shape: React.ReactNode;
  group?: "middleware";
}[] = [
  {
    id: "database",
    label: "数据库",
    shape: (
      <g {...S} strokeWidth={1.7}>
        <ellipse cx="20" cy="12.5" rx="8.5" ry="3.2" {...F} />
        <path d="M11.5 12.5v15c0 1.8 3.8 3.2 8.5 3.2s8.5-1.4 8.5-3.2v-15" />
        <path
          d="M11.5 20c0 1.8 3.8 3.2 8.5 3.2s8.5-1.4 8.5-3.2"
          strokeOpacity=".7"
        />
      </g>
    ),
  },
  {
    id: "kv",
    label: "键值与协调",
    shape: (
      <g {...S}>
        <rect x="9" y="10" width="7" height="6" rx="1.6" {...F} />
        <rect x="9" y="17.5" width="7" height="6" rx="1.6" {...F} />
        <rect x="9" y="25" width="7" height="6" rx="1.6" {...F} />
        <path d="M20 13h11M20 20.5h11M20 28h8" />
      </g>
    ),
  },
  {
    id: "cache",
    label: "缓存",
    shape: (
      <path
        d="M22.5 8 12 22h7l-2 10 11-15h-7.2z"
        fill="#fff"
        fillOpacity=".92"
      />
    ),
  },
  {
    id: "queue",
    label: "队列",
    shape: (
      <g fill="#fff">
        <rect
          x="9"
          y="10.75"
          width="14"
          height="4.5"
          rx="2.2"
          fillOpacity=".95"
        />
        <rect
          x="13"
          y="17.75"
          width="18"
          height="4.5"
          rx="2.2"
          fillOpacity=".7"
        />
        <rect
          x="9"
          y="24.75"
          width="11"
          height="4.5"
          rx="2.2"
          fillOpacity=".5"
        />
      </g>
    ),
  },
  {
    id: "storage",
    label: "存储",
    shape: (
      <g {...S}>
        <path d="M20 8.5 31 14v12l-11 5.5L9 26V14z" {...F} />
        <path d="m9 14 11 5.5L31 14M20 19.5v12" strokeOpacity=".8" />
      </g>
    ),
  },
  {
    id: "search",
    label: "搜索",
    shape: (
      <g {...S} strokeWidth={2.2}>
        <circle cx="17.3" cy="17.3" r="7.5" {...F} />
        <path d="m22.8 22.8 7 7" />
      </g>
    ),
  },
  {
    id: "balance",
    label: "负载均衡",
    shape: (
      <g {...S}>
        <circle cx="20" cy="11" r="3.2" fill="#fff" />
        <path d="M20 14.2V19M20 19 11 26M20 19v7M20 19l9 7" />
        <circle cx="11" cy="28.5" r="2.6" {...F} />
        <circle cx="20" cy="28.5" r="2.6" {...F} />
        <circle cx="29" cy="28.5" r="2.6" {...F} />
      </g>
    ),
  },
  {
    id: "gateway",
    label: "网关与代理",
    shape: (
      <g {...S}>
        <rect x="17.5" y="9" width="5" height="22" rx="2.5" {...F} />
        <path d="M8 16h7M12.5 12.8 15.5 16l-3 3.2M25 24h7M28.5 20.8 31.5 24l-3 3.2" />
      </g>
    ),
  },
  {
    id: "vip",
    label: "高可用与虚拟 IP",
    shape: (
      <g {...S}>
        <path
          d="M20 8.5 30 12.5v7.5c0 5.4-4.2 9.3-10 11.5-5.8-2.2-10-6.1-10-11.5v-7.5z"
          {...F}
        />
        <path d="M13.5 20h3l2-4 3 8 2-4h3" />
      </g>
    ),
  },
  {
    id: "cloud",
    label: "云与外部服务",
    shape: (
      <g {...S}>
        <path
          d="M12.5 28.5a5.5 5.5 0 0 1-.7-10.9 8 8 0 0 1 15.4-1.6 6.3 6.3 0 0 1 .8 12.5z"
          {...F}
        />
      </g>
    ),
  },
  {
    id: "server",
    label: "服务",
    shape: (
      <g {...S}>
        <rect x="9" y="10" width="22" height="8.5" rx="2.4" {...F} />
        <rect x="9" y="21.5" width="22" height="8.5" rx="2.4" {...F} />
        <path d="M13.5 14.2h.1M13.5 25.8h.1M18 14.2h8M18 25.8h8" />
      </g>
    ),
  },
  {
    id: "cluster",
    label: "集群",
    shape: (
      <g {...S}>
        <path d="M20 12 11.5 27M20 12l8.5 15M11.5 27h17" strokeOpacity=".8" />
        <circle cx="20" cy="11.5" r="3.6" fill="#fff" fillOpacity=".9" />
        <circle cx="11" cy="27.5" r="3.6" fill="#fff" fillOpacity=".55" />
        <circle cx="29" cy="27.5" r="3.6" fill="#fff" fillOpacity=".55" />
      </g>
    ),
  },
  {
    id: "monitor",
    label: "监控",
    shape: (
      <g {...S}>
        <rect x="8.5" y="10" width="23" height="16" rx="2.6" {...F} />
        <path d="M12.5 21.5 17 17l3.5 3.5 6-6M15 31h10" />
      </g>
    ),
  },
  {
    id: "key",
    label: "安全与密钥",
    shape: (
      <g {...S}>
        <rect x="11" y="18" width="18" height="12.5" rx="3" {...F} />
        <path d="M15 18v-3.5a5 5 0 0 1 10 0V18M20 23.2v2.6" />
      </g>
    ),
  },
  {
    id: "container",
    label: "容器与通用",
    shape: (
      <g {...S}>
        <path d="M20 9 30 14.5v11L20 31 10 25.5v-11z" {...F} />
        <path d="m10 14.5 10 5.5 10-5.5M20 20v11" strokeOpacity=".75" />
      </g>
    ),
  },
  {
    id: "network",
    label: "网络",
    shape: (
      <g {...S}>
        <circle cx="20" cy="20" r="10.5" {...F} />
        <path
          d="M9.5 20h21M20 9.5c-4 3.2-4 17.8 0 21M20 9.5c4 3.2 4 17.8 0 21"
          strokeOpacity=".85"
        />
      </g>
    ),
  },
  {
    id: "file",
    label: "文件与配置",
    shape: (
      <g {...S}>
        <path d="M12.5 8.5h10l6 6v17h-16z" {...F} />
        <path d="M22.5 8.5v6h6M16.5 21h8M16.5 26h8" />
      </g>
    ),
  },
  {
    id: "bell",
    label: "通知",
    shape: (
      <g {...S}>
        <path d="M12 26.5v-7a8 8 0 0 1 16 0v7l1.8 2.2H10.2z" {...F} />
        <path d="M17 31.5a3.2 3.2 0 0 0 6 0" />
      </g>
    ),
  },
  {
    id: "redis",
    label: "Redis 与内存数据",
    group: "middleware",
    shape: (
      <g {...S}>
        <path d="M20 9 31 14l-11 5-11-5z" {...F} />
        <path d="m9 19 11 5 11-5M9 24l11 5 11-5" strokeOpacity=".8" />
      </g>
    ),
  },
  {
    id: "mysql",
    label: "MySQL 与关系表",
    group: "middleware",
    shape: (
      <g {...S}>
        <rect x="9" y="11" width="22" height="18" rx="3" {...F} />
        <path d="M9 17.5h22M9 23h22M17 17.5V29" />
      </g>
    ),
  },
  {
    id: "kafka",
    label: "Kafka 与消息流",
    group: "middleware",
    shape: (
      <g {...S}>
        <path d="M12 13.5 18 18M12 26.5 18 22M23.5 20H29" />
        <circle cx="10" cy="12" r="3" {...F} />
        <circle cx="10" cy="28" r="3" {...F} />
        <circle cx="20.5" cy="20" r="3.4" fill="#fff" fillOpacity=".9" />
        <circle cx="31" cy="20" r="3" {...F} />
      </g>
    ),
  },
  {
    id: "mongodb",
    label: "MongoDB 与文档库",
    group: "middleware",
    shape: (
      <g {...S}>
        <path d="M20 8c6.5 5.2 8.2 12.5 0 24-8.2-11.5-6.5-18.8 0-24z" {...F} />
        <path d="M20 13v21" strokeOpacity=".8" />
      </g>
    ),
  },
  {
    id: "rabbitmq",
    label: "RabbitMQ 与消息队列",
    group: "middleware",
    shape: (
      <g {...S}>
        <rect x="9" y="12" width="22" height="16" rx="3" {...F} />
        <path d="m10 14 10 8 10-8" />
      </g>
    ),
  },
  {
    id: "elasticsearch",
    label: "Elasticsearch 与检索",
    group: "middleware",
    shape: (
      <g {...S}>
        <circle cx="17.5" cy="17.5" r="8" {...F} />
        <path d="M13.5 15.5h8M13.5 19.5h5M23.5 23.5l7 7" />
      </g>
    ),
  },
  {
    id: "zookeeper",
    label: "ZooKeeper 与协调",
    group: "middleware",
    shape: (
      <g {...S}>
        <circle cx="20" cy="20" r="10.5" {...F} />
        <circle cx="20" cy="9.5" r="2.6" fill="#fff" />
        <circle cx="29" cy="25" r="2.6" fill="#fff" fillOpacity=".8" />
        <circle cx="11" cy="25" r="2.6" fill="#fff" fillOpacity=".8" />
      </g>
    ),
  },
  {
    id: "minio",
    label: "MinIO 与对象存储",
    group: "middleware",
    shape: (
      <g {...S}>
        <path d="M11 14h18l-2 16H13z" {...F} />
        <ellipse cx="20" cy="14" rx="9" ry="3" />
      </g>
    ),
  },
  {
    id: "prometheus",
    label: "Prometheus 与指标",
    group: "middleware",
    shape: (
      <g {...S}>
        <path d="M9.5 27a10.5 10.5 0 0 1 21 0" {...F} />
        <path d="m20 27 6-8M9 30.5h22" />
      </g>
    ),
  },
  {
    id: "grafana",
    label: "Grafana 与看板",
    group: "middleware",
    shape: (
      <g {...S}>
        <rect x="8.5" y="9" width="23" height="22" rx="3" {...F} />
        <path d="M14 26v-5M20 26v-10M26 26v-7" strokeWidth={2.6} />
      </g>
    ),
  },
  {
    id: "kubernetes",
    label: "Kubernetes 与编排",
    group: "middleware",
    shape: (
      <g {...S}>
        <path d="M20 8.5 30 14v12l-10 5.5L10 26V14z" {...F} />
        <circle cx="20" cy="20" r="3.4" fill="#fff" />
        <path
          d="M20 16.6V10M20 23.4V30M23 18.2l5.5-3.2M17 21.8 11.5 25M23 21.8l5.5 3.2M17 18.2 11.5 15"
          strokeOpacity=".8"
        />
      </g>
    ),
  },
  {
    id: "docker",
    label: "Docker 与容器",
    group: "middleware",
    shape: (
      <g {...S}>
        <rect x="9" y="16" width="6" height="6" rx="1" {...F} />
        <rect x="16.5" y="16" width="6" height="6" rx="1" {...F} />
        <rect x="24" y="16" width="6" height="6" rx="1" {...F} />
        <rect x="16.5" y="8.5" width="6" height="6" rx="1" {...F} />
        <path d="M8 25c3.5 6.5 20.5 7 24-3.5" />
      </g>
    ),
  },
];

/** Tile colours: light end at the top, dark end at the bottom; hero is the deeper pair used for product banners. */
export const COLORS: {
  id: string;
  label: string;
  tile: [string, string];
  hero: [string, string];
}[] = [
  {
    id: "indigo",
    label: "靛蓝",
    tile: ["#7b78f2", "#4543b8"],
    hero: ["#6f6cf0", "#2c2a86"],
  },
  {
    id: "blue",
    label: "蓝",
    tile: ["#5d8fd8", "#2f5fa8"],
    hero: ["#4f86e0", "#1f3f86"],
  },
  {
    id: "teal",
    label: "青",
    tile: ["#3cc4ae", "#12796b"],
    hero: ["#36c2ad", "#0f5f55"],
  },
  {
    id: "green",
    label: "绿",
    tile: ["#5dbb63", "#2a7a33"],
    hero: ["#4fb55a", "#1d5a27"],
  },
  {
    id: "amber",
    label: "琥珀",
    tile: ["#f4b552", "#c47a12"],
    hero: ["#f4b552", "#8a5208"],
  },
  {
    id: "coral",
    label: "珊瑚",
    tile: ["#f2806a", "#c23a28"],
    hero: ["#f0866a", "#8a2a1c"],
  },
  {
    id: "red",
    label: "红",
    tile: ["#e5646e", "#b02634"],
    hero: ["#e0566a", "#7d1c2c"],
  },
  {
    id: "pink",
    label: "粉",
    tile: ["#dc7fc8", "#98388a"],
    hero: ["#d97bc4", "#6e2764"],
  },
  {
    id: "slate",
    label: "石板",
    tile: ["#9a9aa2", "#6e6e76"],
    hero: ["#8a96a3", "#2d3640"],
  },
];

/** What a component without its own icon or colour gets, by category. */
const BY_CATEGORY: Record<string, [string, string]> = {
  数据库: ["database", "blue"],
  缓存: ["cache", "coral"],
  消息队列: ["queue", "teal"],
  对象存储: ["storage", "pink"],
  搜索: ["search", "amber"],
  协调服务: ["kv", "teal"],
  负载均衡: ["balance", "blue"],
  网络: ["vip", "indigo"],
};

/* The catalogue tells us each component's own icon and colour; every AppGlyph in the app looks them up here, so the
   many places that draw one by id need no extra props. */
const registry = new Map<string, { icon?: string; color?: string }>();
export function registerStyles(
  list: { id: string; icon?: string; color?: string }[],
) {
  list.forEach((x) => registry.set(x.id, { icon: x.icon, color: x.color }));
}

export function styleOf(
  id: string,
  category?: string,
  icon?: string,
  color?: string,
): { icon: string; color: (typeof COLORS)[number] } {
  const reg = registry.get(id);
  // grey is reserved for "not available yet" (see AppGlyph muted); an unknown category gets a real colour
  const [di, dc] = BY_CATEGORY[category || ""] || ["container", "indigo"];
  const iconId =
    [icon, reg?.icon].find((x) => x && ICONS.some((i) => i.id === x)) || di;
  const colorId =
    [color, reg?.color].find((x) => x && COLORS.some((c) => c.id === x)) || dc;
  return { icon: iconId, color: COLORS.find((c) => c.id === colorId)! };
}

export const iconShape = (id: string) =>
  (ICONS.find((i) => i.id === id) || ICONS.find((i) => i.id === "container")!)
    .shape;
