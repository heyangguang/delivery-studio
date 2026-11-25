import React from "react";
import { bi, canonicalCat } from "../app/i18n";
import { BrandLogoSvg } from "./brandlogos";

const ICON_EN: Record<string, string> = {
  database: "Database",
  kv: "Key-Value & Coordination",
  cache: "Cache",
  queue: "Queue",
  storage: "Storage",
  search: "Search",
  balance: "Load Balancer",
  gateway: "Gateway & Proxy",
  vip: "HA & Virtual IP",
  cloud: "Cloud & External Service",
  server: "Service",
  cluster: "Cluster",
  monitor: "Monitoring",
  key: "Security & Keys",
  container: "Container & Generic",
  network: "Network",
  file: "Files & Config",
  bell: "Notifications",
  postgresql: "PostgreSQL",
  patroni: "Patroni HA",
  redis: "Redis",
  nginx: "Nginx",
  haproxy: "HAProxy",
  keepalived: "Keepalived",
  etcd: "etcd",
  elb: "External ELB",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongodb: "MongoDB",
  kafka: "Apache Kafka",
  rabbitmq: "RabbitMQ",
  elasticsearch: "Elasticsearch",
  zookeeper: "Apache ZooKeeper",
  minio: "MinIO",
  prometheus: "Prometheus",
  grafana: "Grafana",
  kubernetes: "Kubernetes",
  docker: "Docker",
  clickhouse: "ClickHouse",
  nacos: "Nacos",
  consul: "HashiCorp Consul",
  rocketmq: "Apache RocketMQ",
  envoy: "Envoy Proxy",
  traefik: "Traefik",
  valkey: "Valkey",
  tidb: "TiDB",
  opensearch: "OpenSearch",
  memcached: "Memcached",
  harbor: "Harbor",
  zabbix: "Zabbix",
};

const COLOR_EN: Record<string, string> = {
  indigo: "Indigo",
  blue: "Blue",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  coral: "Coral",
  red: "Red",
  pink: "Pink",
  slate: "Slate",
};

/* The logos a component can wear.
   - General icons (group undefined) are monochrome white strokes drawn on tinted tiles.
   - Middleware icons (group: "middleware") are full-colour official-style brand SVGs drawn inside
     crisp porcelain/obsidian badge tiles (zero gradient-id collisions when repeated across lists).
   The ids in ICONS and COLORS MUST equal mwpack.ComponentIcons / ComponentColors (verified by glyphs_test.go). */

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
  /* ---- General Icons (18) ---- */
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
        <rect x="9" y="10.75" width="14" height="4.5" rx="2.2" fillOpacity=".95" />
        <rect x="13" y="17.75" width="18" height="4.5" rx="2.2" fillOpacity=".7" />
        <rect x="9" y="24.75" width="11" height="4.5" rx="2.2" fillOpacity=".5" />
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

  /* ---- Official Normalized Middleware Brand SVGs (32) ---- */
  {
    id: "postgresql",
    label: "PostgreSQL",
    group: "middleware",
    shape: <BrandLogoSvg id="postgresql" />,
  },
  {
    id: "patroni",
    label: "Patroni 高可用",
    group: "middleware",
    shape: <BrandLogoSvg id="patroni" />,
  },
  {
    id: "redis",
    label: "Redis",
    group: "middleware",
    shape: <BrandLogoSvg id="redis" />,
  },
  {
    id: "nginx",
    label: "Nginx",
    group: "middleware",
    shape: <BrandLogoSvg id="nginx" />,
  },
  {
    id: "haproxy",
    label: "HAProxy",
    group: "middleware",
    shape: <BrandLogoSvg id="haproxy" />,
  },
  {
    id: "keepalived",
    label: "Keepalived",
    group: "middleware",
    shape: <BrandLogoSvg id="keepalived" />,
  },
  {
    id: "etcd",
    label: "etcd",
    group: "middleware",
    shape: <BrandLogoSvg id="etcd" />,
  },
  {
    id: "elb",
    label: "外部负载均衡 (ELB)",
    group: "middleware",
    shape: <BrandLogoSvg id="elb" />,
  },
  {
    id: "mysql",
    label: "MySQL",
    group: "middleware",
    shape: <BrandLogoSvg id="mysql" />,
  },
  {
    id: "mariadb",
    label: "MariaDB",
    group: "middleware",
    shape: <BrandLogoSvg id="mariadb" />,
  },
  {
    id: "mongodb",
    label: "MongoDB",
    group: "middleware",
    shape: <BrandLogoSvg id="mongodb" />,
  },
  {
    id: "kafka",
    label: "Apache Kafka",
    group: "middleware",
    shape: <BrandLogoSvg id="kafka" />,
  },
  {
    id: "rabbitmq",
    label: "RabbitMQ",
    group: "middleware",
    shape: <BrandLogoSvg id="rabbitmq" />,
  },
  {
    id: "elasticsearch",
    label: "Elasticsearch",
    group: "middleware",
    shape: <BrandLogoSvg id="elasticsearch" />,
  },
  {
    id: "zookeeper",
    label: "Apache ZooKeeper",
    group: "middleware",
    shape: <BrandLogoSvg id="zookeeper" />,
  },
  {
    id: "minio",
    label: "MinIO",
    group: "middleware",
    shape: <BrandLogoSvg id="minio" />,
  },
  {
    id: "prometheus",
    label: "Prometheus",
    group: "middleware",
    shape: <BrandLogoSvg id="prometheus" />,
  },
  {
    id: "grafana",
    label: "Grafana",
    group: "middleware",
    shape: <BrandLogoSvg id="grafana" />,
  },
  {
    id: "kubernetes",
    label: "Kubernetes",
    group: "middleware",
    shape: <BrandLogoSvg id="kubernetes" />,
  },
  {
    id: "docker",
    label: "Docker",
    group: "middleware",
    shape: <BrandLogoSvg id="docker" />,
  },
  {
    id: "clickhouse",
    label: "ClickHouse",
    group: "middleware",
    shape: <BrandLogoSvg id="clickhouse" />,
  },
  {
    id: "nacos",
    label: "Nacos",
    group: "middleware",
    shape: <BrandLogoSvg id="nacos" />,
  },
  {
    id: "consul",
    label: "HashiCorp Consul",
    group: "middleware",
    shape: <BrandLogoSvg id="consul" />,
  },
  {
    id: "rocketmq",
    label: "Apache RocketMQ",
    group: "middleware",
    shape: <BrandLogoSvg id="rocketmq" />,
  },
  {
    id: "envoy",
    label: "Envoy Proxy",
    group: "middleware",
    shape: <BrandLogoSvg id="envoy" />,
  },
  {
    id: "traefik",
    label: "Traefik",
    group: "middleware",
    shape: <BrandLogoSvg id="traefik" />,
  },
  {
    id: "valkey",
    label: "Valkey",
    group: "middleware",
    shape: <BrandLogoSvg id="valkey" />,
  },
  {
    id: "tidb",
    label: "TiDB",
    group: "middleware",
    shape: <BrandLogoSvg id="tidb" />,
  },
  {
    id: "opensearch",
    label: "OpenSearch",
    group: "middleware",
    shape: <BrandLogoSvg id="opensearch" />,
  },
  {
    id: "memcached",
    label: "Memcached",
    group: "middleware",
    shape: <BrandLogoSvg id="memcached" />,
  },
  {
    id: "harbor",
    label: "Harbor",
    group: "middleware",
    shape: <BrandLogoSvg id="harbor" />,
  },
  {
    id: "zabbix",
    label: "Zabbix",
    group: "middleware",
    shape: <BrandLogoSvg id="zabbix" />,
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
    tile: ["#5b6ee1", "#3a49b5"],
    hero: ["#4b5cd4", "#232c78"],
  },
  {
    id: "blue",
    label: "蓝",
    tile: ["#3b82c4", "#24558d"],
    hero: ["#336791", "#18375c"],
  },
  {
    id: "teal",
    label: "青",
    tile: ["#2aa89c", "#0f766e"],
    hero: ["#1f8a80", "#0b4f4a"],
  },
  {
    id: "green",
    label: "绿",
    tile: ["#2ea053", "#187439"],
    hero: ["#009639", "#0f5228"],
  },
  {
    id: "amber",
    label: "琥珀",
    tile: ["#e59a28", "#b4690e"],
    hero: ["#d97706", "#7c4508"],
  },
  {
    id: "coral",
    label: "珊瑚",
    tile: ["#e8634a", "#b83520"],
    hero: ["#dc382d", "#801e16"],
  },
  {
    id: "red",
    label: "红",
    tile: ["#dc382d", "#a41e11"],
    hero: ["#c82829", "#781414"],
  },
  {
    id: "pink",
    label: "粉",
    tile: ["#c95ea8", "#8e3272"],
    hero: ["#c72e49", "#6e1a2b"],
  },
  {
    id: "slate",
    label: "石板",
    tile: ["#64748b", "#334155"],
    hero: ["#475569", "#1e293b"],
  },
];

const ICON_MAP = new Map(ICONS.map((i) => [i.id, i]));
const COLOR_MAP = new Map(COLORS.map((c) => [c.id, c]));
const FALLBACK_ICON_SHAPE = ICON_MAP.get("container")!.shape;

export const iconLabel = (id: string, fallback?: string): string =>
  bi(
    fallback || ICON_MAP.get(id)?.label || id,
    ICON_EN[id] || fallback || id,
  );

export const colorLabel = (id: string, fallback?: string): string =>
  bi(
    fallback || COLOR_MAP.get(id)?.label || id,
    COLOR_EN[id] || fallback || id,
  );

const BRAND_SET = new Set(
  ICONS.filter((i) => i.group === "middleware").map((i) => i.id),
);

export const isBrandIcon = (iconId: string): boolean => BRAND_SET.has(iconId);

const GENERIC_SET = new Set(
  ICONS.filter((i) => !i.group).map((i) => i.id),
);

/** Auto-recognize common middleware by component/app id so legacy manifests immediately display brand SVGs. */
const BRAND_PATTERNS: [RegExp, string][] = [
  [/patroni/i, "patroni"],
  [/postgres|\bpg\b|^pg[-_]/i, "postgresql"],
  [/valkey/i, "valkey"],
  [/redis/i, "redis"],
  [/nginx|openresty/i, "nginx"],
  [/haproxy/i, "haproxy"],
  [/keepalived/i, "keepalived"],
  [/etcd/i, "etcd"],
  [/external[-_]?lb|\belb\b|\bslb\b|\balb\b|\bnlb\b/i, "elb"],
  [/mariadb/i, "mariadb"],
  [/mysql/i, "mysql"],
  [/mongo/i, "mongodb"],
  [/kafka/i, "kafka"],
  [/rabbitmq/i, "rabbitmq"],
  [/rocketmq/i, "rocketmq"],
  [/opensearch/i, "opensearch"],
  [/elastic/i, "elasticsearch"],
  [/zookeeper|\bzk\b/i, "zookeeper"],
  [/minio/i, "minio"],
  [/prometheus/i, "prometheus"],
  [/grafana/i, "grafana"],
  [/kubernetes|\bk8s\b/i, "kubernetes"],
  [/docker/i, "docker"],
  [/clickhouse/i, "clickhouse"],
  [/nacos/i, "nacos"],
  [/consul/i, "consul"],
  [/envoy/i, "envoy"],
  [/traefik/i, "traefik"],
  [/tidb/i, "tidb"],
  [/memcached/i, "memcached"],
  [/harbor/i, "harbor"],
  [/zabbix/i, "zabbix"],
];

export function inferBrandIcon(id?: string): string | undefined {
  if (!id) return undefined;
  const low = id.toLowerCase();
  if (BRAND_SET.has(low)) return low;
  for (const [re, target] of BRAND_PATTERNS) {
    if (re.test(low)) return target;
  }
  return undefined;
}

/** What a component without its own icon or colour gets, by category. */
const BY_CATEGORY: Record<string, [string, string]> = {
  数据库: ["database", "blue"],
  缓存: ["cache", "coral"],
  消息队列: ["queue", "teal"],
  对象存储: ["storage", "pink"],
  搜索: ["search", "amber"],
  协调服务: ["kv", "teal"],
  负载均衡: ["balance", "blue"],
  网络: ["vip", "teal"],
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
  const [di, dc] = BY_CATEGORY[canonicalCat(category)] || ["container", "slate"];
  const explicit =
    (icon && ICON_MAP.has(icon) ? icon : undefined) ||
    (reg?.icon && ICON_MAP.has(reg.icon) ? reg.icon : undefined);
  const inferred = inferBrandIcon(id);
  // Upgrade legacy generic category icons automatically when component id clearly matches a known middleware brand.
  const iconId =
    explicit && !GENERIC_SET.has(explicit)
      ? explicit
      : inferred || explicit || di;
  const colorId =
    (color && COLOR_MAP.has(color) ? color : undefined) ||
    (reg?.color && COLOR_MAP.has(reg.color) ? reg.color : undefined) ||
    dc;
  return { icon: iconId, color: COLOR_MAP.get(colorId)! };
}

export const iconShape = (id: string) =>
  ICON_MAP.get(id)?.shape || FALLBACK_ICON_SHAPE;

for (const it of ICONS) {
  const zh = it.label;
  Object.defineProperty(it, "label", {
    enumerable: true,
    get() {
      return bi(zh, ICON_EN[it.id] || zh);
    },
  });
}

for (const col of COLORS) {
  const zh = col.label;
  Object.defineProperty(col, "label", {
    enumerable: true,
    get() {
      return bi(zh, COLOR_EN[col.id] || zh);
    },
  });
}
