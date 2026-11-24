import React from "react";
import { bi, canonicalCat } from "./i18n";

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

  /* ---- Official-Style Middleware Brand SVGs (32) ---- */
  {
    id: "postgresql",
    label: "PostgreSQL",
    group: "middleware",
    shape: (
      /* Iconic Slonik Elephant Head Silhouette (#336791) */
      <g>
        {/* Left floppy ear */}
        <path
          d="M15.4 10.6c-3.8-.6-6.9 2.2-6.6 6.8.3 4.3 2.5 7.5 5.4 7.7 1.3.1 2.2-.8 2.4-2.1"
          fill="#3B77A8"
        />
        {/* Right ear */}
        <path
          d="M24.2 10.4c3.9-.8 7.3 1.9 7 6.8-.3 4.4-2.4 7.6-5.3 7.7-1.1 0-1.9-.6-2.2-1.7"
          fill="#2D5F8A"
        />
        {/* Main head & curved trunk */}
        <path
          d="M14.2 13.5c0-3.3 2.5-5.3 5.8-5.3 3.4 0 5.9 2.2 5.9 5.6 0 2.5-.8 4.4-1.5 6.4-.8 2.3-.7 5.8.4 7.6.8 1.3 2.2 1.4 3.1.4.6-.7.5-1.7-.1-2.1-.6-.4-1.3-.1-1.4.5 1.8.2 3.1 1.7 2.2 3.4-.9 1.8-3.4 2.3-5.2 1.2-2.2-1.3-2.9-4.5-2.6-7.7-.6.2-1.2.3-1.8.3-2.9 0-4.8-2.4-4.8-5.8v-4.5z"
          fill="#3B77A8"
        />
        {/* Inner ear folds & tusks */}
        <path
          d="M12.3 14.3c-1.1 1.6-1 4.6.4 6.5"
          stroke="#fff"
          strokeWidth="1.25"
          strokeLinecap="round"
          fill="none"
          opacity=".65"
        />
        <path
          d="M16.2 21.8c.5 2.1 1.6 3.5 3 3.9M23.5 21.4c-.3 1.7-.9 2.9-1.9 3.6"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        {/* Crisp Slonik eyes */}
        <circle cx="17.8" cy="15.3" r="1.2" fill="#fff" />
        <circle cx="22.1" cy="15.3" r="1.2" fill="#fff" />
      </g>
    ),
  },
  {
    id: "patroni",
    label: "Patroni 高可用",
    group: "middleware",
    shape: (
      /* HA Leader Crown + Primary/Replica Postgres Cluster Emblem */
      <g>
        {/* Golden HA Leader Crown */}
        <path
          d="M11.5 15.2 13.5 9l4 3.2L20 7.8l2.5 4.4 4-3.2 2 6.2z"
          fill="#F59E0B"
        />
        <rect x="11.5" y="15.2" width="17" height="2.2" rx="1" fill="#D97706" />
        {/* Royal Blue Database Core */}
        <path
          d="M11.5 19.6c0-1.4 3.8-2.4 8.5-2.4s8.5 1 8.5 2.4v8.2c0 1.4-3.8 2.5-8.5 2.5s-8.5-1.1-8.5-2.5v-8.2z"
          fill="#2563EB"
        />
        <ellipse cx="20" cy="19.6" rx="8.5" ry="2.3" fill="#60A5FA" />
        <path
          d="M11.5 23.7c0 1.3 3.8 2.3 8.5 2.3s8.5-1 8.5-2.3"
          stroke="#fff"
          strokeWidth="1.2"
          strokeOpacity=".65"
          fill="none"
        />
        {/* Active leader pulse dot */}
        <circle cx="20" cy="32.2" r="1.8" fill="#10B981" />
        <circle cx="14.2" cy="31.8" r="1.3" fill="#93C5FD" />
        <circle cx="25.8" cy="31.8" r="1.3" fill="#93C5FD" />
      </g>
    ),
  },
  {
    id: "redis",
    label: "Redis",
    group: "middleware",
    shape: (
      /* Official Redis 3D Stacked Crimson Layers + Star/Cube Marks */
      <g>
        {/* Bottom layer */}
        <path d="M20 22.8 32.5 27.6 20 32.5 7.5 27.6z" fill="#991B1B" />
        <path d="M7.5 25.1v2.5L20 32.5v-2.5z" fill="#7F1D1D" />
        <path d="M32.5 25.1v2.5L20 32.5v-2.5z" fill="#B91C1C" />
        {/* Middle layer */}
        <path d="M20 17.8 32.5 22.6 20 27.5 7.5 22.6z" fill="#B91C1C" />
        <path d="M7.5 20.1v2.5L20 27.5v-2.5z" fill="#991B1B" />
        <path d="M32.5 20.1v2.5L20 27.5v-2.5z" fill="#DC2626" />
        {/* Top layer */}
        <path d="M20 9.5 32.5 14.6 20 19.8 7.5 14.6z" fill="#EF4444" />
        <path d="M7.5 14.6v2.7L20 22.5v-2.7z" fill="#B91C1C" />
        <path d="M32.5 14.6v2.7L20 22.5v-2.7z" fill="#DC2626" />
        {/* Iconic white top-face marks (star, cube, ellipse, triangle) */}
        <path
          d="M15 13.1l.8 1.3 1.5.2-1.1.9.3 1.4-1.5-.7-1.4.7.3-1.4-1.1-.9 1.5-.2z"
          fill="#fff"
        />
        <ellipse cx="21.2" cy="12.5" rx="2.1" ry="1.1" fill="#fff" />
        <path d="M25.5 13.7l2.5 1-2.5 1-2.5-1z" fill="#fff" />
        <path d="M19.8 16l2.4.9-2.4 1.3z" fill="#fff" opacity=".92" />
      </g>
    ),
  },
  {
    id: "nginx",
    label: "Nginx",
    group: "middleware",
    shape: (
      /* Official Nginx Emerald Upright Hexagon + Geometric N */
      <g>
        <path
          d="M20 7.2 31.2 13.6v12.8L20 32.8 8.8 26.4V13.6z"
          fill="#009639"
        />
        <path
          d="M14.4 26.4V13.9c0-.8.9-1.2 1.5-.6l8.6 9.8c.5.5 1.1.2 1.1-.5v-9"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    ),
  },
  {
    id: "haproxy",
    label: "HAProxy",
    group: "middleware",
    shape: (
      /* Official HAProxy Royal/Sky Blue Intersecting Split-Arrow H */
      <g>
        <path
          d="M9.5 10.5h4.2v19H9.5zM26.3 10.5h4.2v19h-4.2z"
          fill="#106DA9"
        />
        <path
          d="M13.5 17.8h8.8v-3l4.6 5.2-4.6 5.2v-3h-8.8z"
          fill="#26A9E0"
        />
        <path
          d="M26.5 14.2l-5.2 5.8 5.2 5.8"
          fill="none"
          stroke="#106DA9"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity=".45"
        />
        <circle cx="11.6" cy="10.5" r="2.1" fill="#106DA9" />
        <circle cx="28.4" cy="29.5" r="2.1" fill="#106DA9" />
      </g>
    ),
  },
  {
    id: "keepalived",
    label: "Keepalived",
    group: "middleware",
    shape: (
      /* Precision Deep Spruce VRRP Failover Shield + Emerald Heartbeat */
      <g>
        <path
          d="M20 7.6 30.8 12v8.4c0 6.2-4.4 10.5-10.8 12.6-6.4-2.1-10.8-6.4-10.8-12.6V12z"
          fill="#0F766E"
        />
        <path
          d="M20 9.6 28.8 13.2v7.2c0 5-3.4 8.5-8.8 10.3V9.6z"
          fill="#14B8A6"
          opacity=".32"
        />
        <path
          d="M12.2 20.5h3.5l2.2-5 3.3 9.4 2.3-4.4h4.3"
          fill="none"
          stroke="#fff"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="28" cy="20.5" r="1.7" fill="#6EE7B7" />
      </g>
    ),
  },
  {
    id: "etcd",
    label: "etcd",
    group: "middleware",
    shape: (
      /* Official CNCF etcd Symmetric 6-Petal Star + Core Hexagon */
      <g>
        <path d="M20 7.2 23.2 10.2 21.7 13.8h-3.4L16.8 10.2z" fill="#419EDA" />
        <path
          d="M20 7.2 23.2 10.2 21.7 13.8h-3.4L16.8 10.2z"
          fill="#2B82C9"
          transform="rotate(60 20 20)"
        />
        <path
          d="M20 7.2 23.2 10.2 21.7 13.8h-3.4L16.8 10.2z"
          fill="#419EDA"
          transform="rotate(120 20 20)"
        />
        <path
          d="M20 7.2 23.2 10.2 21.7 13.8h-3.4L16.8 10.2z"
          fill="#2B82C9"
          transform="rotate(180 20 20)"
        />
        <path
          d="M20 7.2 23.2 10.2 21.7 13.8h-3.4L16.8 10.2z"
          fill="#419EDA"
          transform="rotate(240 20 20)"
        />
        <path
          d="M20 7.2 23.2 10.2 21.7 13.8h-3.4L16.8 10.2z"
          fill="#2B82C9"
          transform="rotate(300 20 20)"
        />
        <path
          d="M20 15.8 23.6 17.9v4.2L20 24.2 16.4 22.1v-4.2z"
          fill="#0284C7"
        />
        <circle cx="20" cy="20" r="1.7" fill="#fff" />
      </g>
    ),
  },
  {
    id: "elb",
    label: "外部负载均衡 (ELB)",
    group: "middleware",
    shape: (
      /* Architectural Cloud + Balanced 3-Way Distribution Emblem */
      <g>
        <path
          d="M13 21.8a4.6 4.6 0 0 1-.5-9.1 6.8 6.8 0 0 1 13.2-1.3 5.2 5.2 0 0 1 .7 10.4z"
          fill="#F59E0B"
        />
        <path
          d="M13 21.8h13.4a5.2 5.2 0 0 0 .6-10.3c-1.8 3.6-6.2 6.8-14 10.3z"
          fill="#D97706"
          opacity=".35"
        />
        <path
          d="M20 21.8v4M20 25.8l-7.5 3.6M20 25.8v4.2M20 25.8l7.5 3.6"
          stroke="#B45309"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12.2" cy="30.2" r="2.1" fill="#F59E0B" />
        <circle cx="20" cy="30.6" r="2.1" fill="#D97706" />
        <circle cx="27.8" cy="30.2" r="2.1" fill="#F59E0B" />
      </g>
    ),
  },
  {
    id: "mysql",
    label: "MySQL",
    group: "middleware",
    shape: (
      /* Iconic MySQL Ocean-Teal Dolphin + Amber Wave */
      <g>
        <path
          d="M10 25.8c1.6-7.6 7-14.4 13.6-15.4 3.5-.5 6.4 1.3 7.5 4.2-2.2-.8-4.4-.5-6.2.8 1.5 1 2.2 2.4 2.1 4.2-1.6-1.1-3.3-1.4-5.2-.9-2.8.8-5.1 3.7-6.6 7.5-1.1.4-2.5.4-3.7 0-.5-.1-1-.2-1.5-.4z"
          fill="#00758F"
        />
        <path
          d="M21.4 10.8c1.3-1.9 3.3-2.9 5.3-2.6-.7 1.3-1.1 2.4-1.2 3.4"
          fill="#00758F"
        />
        <circle cx="25.2" cy="13.2" r="1.15" fill="#fff" />
        <path
          d="M9.5 29.4c4.5-2.6 10.4-2.8 16.2-.8 2 .7 3.6.7 5.2-.1"
          fill="none"
          stroke="#F29111"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </g>
    ),
  },
  {
    id: "mariadb",
    label: "MariaDB",
    group: "middleware",
    shape: (
      /* Iconic MariaDB Ocean-Teal Sea-Lion Silhouette + Bronze Accent */
      <g>
        <path
          d="M8.5 26.8c3.6-1.2 6.8-3.8 9.2-8.2 1.8-3.3 4.2-6.8 8-7.4 2.3-.4 4.1.8 4.8 2.4-1.7.1-3.2.8-4.2 2.1-.9 1.1-1.3 2.7-.8 4.4.6 2 2.4 3.4 4.8 4.3-2.5 1.8-6.4 2.7-11.2 2.6-3.7-.1-7.2.4-10.6 1.5z"
          fill="#156B85"
        />
        <path
          d="M21 26.2c3.2.5 6.4.1 9.5-1.4"
          stroke="#D4845E"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="26.1" cy="13.5" r="1.1" fill="#fff" />
      </g>
    ),
  },
  {
    id: "mongodb",
    label: "MongoDB",
    group: "middleware",
    shape: (
      /* Official MongoDB Two-Tone Vibrant Green Leaf */
      <g>
        <path
          d="M20 7.4c5.8 5.2 8.2 11.4 6.2 17.4-1.2 3.6-3.5 5.6-6.2 6.8V7.4z"
          fill="#00B14F"
        />
        <path
          d="M20 7.4c-5.8 5.2-8.2 11.4-6.2 17.4 1.2 3.6 3.5 5.6 6.2 6.8V7.4z"
          fill="#00ED64"
        />
        <path
          d="M20 12.2v20.6"
          stroke="#00684A"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </g>
    ),
  },
  {
    id: "kafka",
    label: "Apache Kafka",
    group: "middleware",
    shape: (
      /* Official Apache Kafka Connected Triad Rings (adapts Light/Dark via currentColor) */
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14.5 12.2v15.6M17.2 18.2l5.8-3.8M17.2 21.8l5.8 3.8" />
        <circle cx="14.5" cy="9.5" r="2.7" fill="var(--glyph-bg, #fff)" />
        <circle cx="14.5" cy="20" r="3.4" fill="var(--glyph-bg, #fff)" />
        <circle cx="14.5" cy="30.5" r="2.7" fill="var(--glyph-bg, #fff)" />
        <circle cx="25.5" cy="12.8" r="2.9" fill="var(--glyph-bg, #fff)" />
        <circle cx="25.5" cy="27.2" r="2.9" fill="var(--glyph-bg, #fff)" />
      </g>
    ),
  },
  {
    id: "rabbitmq",
    label: "RabbitMQ",
    group: "middleware",
    shape: (
      /* Official RabbitMQ Iconic Orange Geometric Bunny */
      <g>
        <path
          d="M11 8.5h3.8c.7 0 1.2.5 1.2 1.2v7.8h3.2V9.7c0-.7.5-1.2 1.2-1.2h3.8c.7 0 1.2.5 1.2 1.2v8.8h3.4c1.2 0 2.2 1 2.2 2.2v8.8c0 1.2-1 2.2-2.2 2.2H12.2c-1.2 0-2.2-1-2.2-2.2V9.7c0-.7.4-1.2 1-1.2z"
          fill="#FF6600"
        />
        <rect x="22.8" y="23.2" width="4.4" height="4.4" rx="1" fill="#fff" />
      </g>
    ),
  },
  {
    id: "elasticsearch",
    label: "Elasticsearch",
    group: "middleware",
    shape: (
      /* Official Elastic Tri-Color Geometric Circle */
      <g>
        <path
          d="M10.2 15.8c1.6-4.5 5.9-7.8 11-7.8 3.6 0 6.8 1.6 8.9 4.2-.8 2.2-2.9 3.6-5.4 3.6H10.2z"
          fill="#FEC514"
        />
        <rect x="8.2" y="17.2" width="21.4" height="5.6" rx="2.8" fill="#00BFB3" />
        <path
          d="M10.2 24.2h14.5c2.5 0 4.6 1.4 5.4 3.6-2.1 2.6-5.3 4.2-8.9 4.2-5.1 0-9.4-3.3-11-7.8z"
          fill="#0077A3"
        />
        <circle cx="29.6" cy="20" r="2.8" fill="#24BBB1" opacity=".75" />
      </g>
    ),
  },
  {
    id: "zookeeper",
    label: "Apache ZooKeeper",
    group: "middleware",
    shape: (
      /* Quorum Consensus Ring with Leader + Followers */
      <g>
        <circle
          cx="20"
          cy="20.5"
          r="9.8"
          fill="none"
          stroke="#2563EB"
          strokeWidth="2.1"
          strokeDasharray="4 2.5"
        />
        <path
          d="M20 11.2 12 25.5h16z"
          fill="#DBEAFE"
          stroke="#1D4ED8"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="10.8" r="3.4" fill="#F59E0B" />
        <circle cx="11.6" cy="25.8" r="3.1" fill="#2563EB" />
        <circle cx="28.4" cy="25.8" r="3.1" fill="#2563EB" />
      </g>
    ),
  },
  {
    id: "minio",
    label: "MinIO",
    group: "middleware",
    shape: (
      /* Official MinIO Crimson Swept-Wing M-Bird */
      <g>
        <path
          d="M9 28.5V14.2c0-1.6 1.8-2.5 3.1-1.5L20 19l7.9-6.3c1.3-1 3.1-.1 3.1 1.5v14.3h-4.2v-9.4L20 24.5l-6.8-5.4v9.4z"
          fill="#C72E49"
        />
        <path d="M20 9.2 23.2 12 20 14.8 16.8 12z" fill="#E11D48" />
      </g>
    ),
  },
  {
    id: "prometheus",
    label: "Prometheus",
    group: "middleware",
    shape: (
      /* Official Prometheus Orange Medallion & Flame Torch */
      <g>
        <circle cx="20" cy="20" r="12.2" fill="#E6522C" />
        <path
          d="M20 10.6c1.5 2.2 2.4 4.1 1.6 6.2 1.4-.6 2.5-1.7 2.8-3.2 1.6 1.8 2 4.7.8 7.2H14.8c-1.2-2.5-.8-5.4.8-7.2.3 1.5 1.4 2.6 2.8 3.2-.8-2.1.1-4 1.6-6.2z"
          fill="#fff"
        />
        <rect x="13.2" y="23" width="13.6" height="2.1" rx="1" fill="#fff" />
        <path d="M16.2 26.8h7.6a3.8 3.8 0 0 1-7.6 0z" fill="#fff" />
      </g>
    ),
  },
  {
    id: "grafana",
    label: "Grafana",
    group: "middleware",
    shape: (
      /* Official Grafana Layered Orange-Gold Spiral Flame */
      <g>
        <circle
          cx="20"
          cy="20.5"
          r="10.2"
          fill="none"
          stroke="#F46800"
          strokeWidth="3.2"
          strokeDasharray="48 16"
          strokeLinecap="round"
        />
        <path
          d="M20 8.5c2.2 1.8 3.2 3.8 2.8 6 2.2.2 4 1.4 4.8 3.4M29.6 22.8c-1.1 3.8-4.4 6.8-8.8 7.2-5 .5-9.5-3-10.2-8-.6-4.2 1.9-8.1 5.9-9.4"
          fill="none"
          stroke="#FAAD14"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="20" cy="20.5" r="4.2" fill="#F46800" />
        <circle cx="20" cy="20.5" r="1.9" fill="#FEF08A" />
      </g>
    ),
  },
  {
    id: "kubernetes",
    label: "Kubernetes",
    group: "middleware",
    shape: (
      /* Official CNCF Kubernetes Blue Heptagon Helm Wheel */
      <g>
        <path
          d="M20 7.4 29.8 12.1 32.2 22.7 25.4 31.3H14.6L7.8 22.7 10.2 12.1z"
          fill="#326CE5"
        />
        <circle
          cx="20"
          cy="20.2"
          r="5.6"
          fill="none"
          stroke="#fff"
          strokeWidth="1.9"
        />
        <circle cx="20" cy="20.2" r="2.2" fill="#fff" />
        <path
          d="M20 11.4v5.8M20 23.2v5.6M27 15.6l-4.8 3.1M13 15.6l4.8 3.1M26.2 25.4l-4.2-3.4M13.8 25.4l4.2-3.4"
          stroke="#fff"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </g>
    ),
  },
  {
    id: "docker",
    label: "Docker",
    group: "middleware",
    shape: (
      /* Official Docker Blue Container Whale */
      <g>
        <g fill="#2496ED">
          <rect x="11.5" y="16.2" width="3.4" height="3.1" rx=".5" />
          <rect x="15.7" y="16.2" width="3.4" height="3.1" rx=".5" />
          <rect x="19.9" y="16.2" width="3.4" height="3.1" rx=".5" />
          <rect x="24.1" y="16.2" width="3.4" height="3.1" rx=".5" />
          <rect x="15.7" y="12.3" width="3.4" height="3.1" rx=".5" />
          <rect x="19.9" y="12.3" width="3.4" height="3.1" rx=".5" />
          <rect x="19.9" y="8.4" width="3.4" height="3.1" rx=".5" />
        </g>
        <path
          d="M8.5 21.2h20.4c1.2-.2 2.4-.9 2.9-2.1 1 .8 1.4 2.1.9 3.4-.5 1.3-1.8 2-3.2 2.2-2.2 4.3-6.7 6.8-12 6.8-5.5 0-9.4-3.3-9-10.3z"
          fill="#2496ED"
        />
        <circle cx="14.2" cy="25.2" r="1.15" fill="#fff" />
      </g>
    ),
  },
  {
    id: "clickhouse",
    label: "ClickHouse",
    group: "middleware",
    shape: (
      /* Official ClickHouse Iconic 5 Vertical Yellow/Red Bars */
      <g>
        <rect x="8.8" y="10.2" width="3.4" height="14.4" rx="1" fill="#FFCC01" />
        <rect x="8.8" y="24.6" width="3.4" height="5.2" rx="1" fill="#FF0000" />
        <rect x="14.2" y="10.2" width="3.4" height="19.6" rx="1" fill="#FFCC01" />
        <rect x="19.6" y="10.2" width="3.4" height="19.6" rx="1" fill="#FFCC01" />
        <rect x="25" y="10.2" width="3.4" height="19.6" rx="1" fill="#FFCC01" />
        <rect x="30.2" y="17.2" width="2.8" height="5.6" rx="1" fill="#FFCC01" />
      </g>
    ),
  },
  {
    id: "nacos",
    label: "Nacos",
    group: "middleware",
    shape: (
      /* Nacos Dynamic Service Discovery Interlocking N Ribbon */
      <g>
        <path
          d="M11 29V11.5c0-1 1.2-1.5 1.9-.8l14.2 14.8c.7.7 1.9.2 1.9-.8V11"
          fill="none"
          stroke="#2563EB"
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="11" cy="29" r="2.6" fill="#06B6D4" />
        <circle cx="29" cy="11" r="2.6" fill="#06B6D4" />
      </g>
    ),
  },
  {
    id: "consul",
    label: "HashiCorp Consul",
    group: "middleware",
    shape: (
      /* Official HashiCorp Consul Rose-Pink Core + Concentric Mesh Dots */
      <g fill="#E03875">
        <path
          d="M21.4 13.5a6.8 6.8 0 1 0 0 13"
          fill="none"
          stroke="#E03875"
          strokeWidth="3.1"
          strokeLinecap="round"
        />
        <circle cx="17.8" cy="20" r="2.2" />
        <circle cx="24.2" cy="16.5" r="1.5" />
        <circle cx="25.6" cy="20" r="1.5" />
        <circle cx="24.2" cy="23.5" r="1.5" />
        <circle cx="29.4" cy="14.2" r="1.5" />
        <circle cx="31.2" cy="18" r="1.5" />
        <circle cx="31.2" cy="22" r="1.5" />
        <circle cx="29.4" cy="25.8" r="1.5" />
      </g>
    ),
  },
  {
    id: "rocketmq",
    label: "Apache RocketMQ",
    group: "middleware",
    shape: (
      /* Official Apache RocketMQ Orbital Ring & Orange Rocket */
      <g>
        <ellipse
          cx="20"
          cy="20.5"
          rx="12.2"
          ry="6.4"
          transform="rotate(-24 20 20.5)"
          fill="none"
          stroke="#D77310"
          strokeWidth="2.3"
        />
        <path
          d="M26.8 10.6c-4.5.8-8.2 3.8-10.5 7.8l-3.2.6 2.6 2.6 2.6 2.6.6-3.2c4-2.3 7-6 7.9-10.4z"
          fill="#EA580C"
        />
        <circle cx="21.4" cy="16.2" r="1.5" fill="#fff" />
        <path
          d="M13.2 24.4l-2.6 3.2 3.2-2.6"
          stroke="#F59E0B"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    ),
  },
  {
    id: "envoy",
    label: "Envoy Proxy",
    group: "middleware",
    shape: (
      /* Official CNCF Envoy Violet Diamond Frame + Stylized E */
      <g>
        <path
          d="M20 7.6 31.8 14.4v11.2L20 32.4 8.2 25.6V14.4z"
          fill="#AC6199"
        />
        <path
          d="M15.4 14.4h9.4M15.4 20h7.6M15.4 25.6h9.4M15.4 14.4v11.2"
          fill="none"
          stroke="#fff"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    ),
  },
  {
    id: "traefik",
    label: "Traefik",
    group: "middleware",
    shape: (
      /* Official Traefik Cyan Dual-Route Circular Badge */
      <g>
        <circle cx="20" cy="20" r="12" fill="#24A1C1" />
        <path
          d="M12.5 23.5c2.2-6 5.2-9 7.5-9s5.3 3 7.5 9M15 24.5h10M20 14.5v10"
          fill="none"
          stroke="#fff"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="13.8" r="2" fill="#fff" />
      </g>
    ),
  },
  {
    id: "valkey",
    label: "Valkey",
    group: "middleware",
    shape: (
      /* Official Linux Foundation Valkey Royal Hexagon V-Key */
      <g>
        <path
          d="M20 7.4 31 13.7v12.6L20 32.6 9 26.3V13.7z"
          fill="#4361EE"
        />
        <path
          d="M14.2 14.6 20 26.4l5.8-11.8"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="15.2" r="2.2" fill="#93C5FD" />
      </g>
    ),
  },
  {
    id: "tidb",
    label: "TiDB",
    group: "middleware",
    shape: (
      /* Official PingCAP TiDB Crimson Isometric Cube + T/i */
      <g>
        <path
          d="M20 7.4 31.2 13.8v12.4L20 32.6 8.8 26.2V13.8z"
          fill="#E30C34"
        />
        <path
          d="M13 15.2h10.4M18.2 15.2v11.6M25.4 18.8v8"
          fill="none"
          stroke="#fff"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
        <circle cx="25.4" cy="14.8" r="1.5" fill="#fff" />
      </g>
    ),
  },
  {
    id: "opensearch",
    label: "OpenSearch",
    group: "middleware",
    shape: (
      /* Official OpenSearch Blue Sweeping Crescent Lens */
      <g>
        <path
          d="M27.8 11.4c-6.8-2.6-14.6 1.2-17.2 8.2-1.4 3.8-1 7.9.8 11.2 1.6-4.5 5.4-8.1 10.4-9.5 4.2-1.2 7.2-4.6 6-9.9z"
          fill="#0EA5E9"
        />
        <path
          d="M29.4 16.4c.8 4.4-1.2 9.2-5.4 11.6-3.4 1.9-7.4 2.1-10.8.8 3.8-.6 7.2-2.8 9.2-6.2 1.6-2.7 3.8-4.9 7-6.2z"
          fill="#005EB8"
        />
      </g>
    ),
  },
  {
    id: "memcached",
    label: "Memcached",
    group: "middleware",
    shape: (
      /* Crisp Teal Fast-Memory M-Block */
      <g>
        <rect x="8.8" y="9.4" width="22.4" height="21.2" rx="5.5" fill="#00A87E" />
        <path
          d="M13.5 25.5v-11l6.5 6.8 6.5-6.8v11"
          fill="none"
          stroke="#fff"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    ),
  },
  {
    id: "harbor",
    label: "Harbor",
    group: "middleware",
    shape: (
      /* Official CNCF Harbor Striped Lighthouse & Light Beams */
      <g>
        <path d="M16.5 14h7l2 16.5h-11z" fill="#2563EB" />
        <path d="M16 18.8h8l.5 3.6h-9z" fill="#60B932" />
        <path d="M17.2 10.6 20 8l2.8 2.6V14h-5.6z" fill="#60B932" />
        <path
          d="M23.6 12.2 31.8 9.2v6zM16.4 12.2 8.2 9.2v6z"
          fill="#60B932"
          opacity=".42"
        />
        <rect x="11.5" y="30" width="17" height="2.4" rx="1.2" fill="#1E40AF" />
      </g>
    ),
  },
  {
    id: "zabbix",
    label: "Zabbix",
    group: "middleware",
    shape: (
      /* Official Zabbix Crimson Square Badge + Geometric Z */
      <g>
        <rect x="8.6" y="8.6" width="22.8" height="22.8" rx="4.5" fill="#D40000" />
        <path
          d="M14.2 14.2h11.6L14.2 25.8h11.6"
          fill="none"
          stroke="#fff"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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

export const iconLabel = (id: string, fallback?: string): string =>
  bi(
    fallback || ICONS.find((i) => i.id === id)?.label || id,
    ICON_EN[id] || fallback || id,
  );

export const colorLabel = (id: string, fallback?: string): string =>
  bi(
    fallback || COLORS.find((c) => c.id === id)?.label || id,
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
  const explicit = [icon, reg?.icon].find(
    (x) => x && ICONS.some((i) => i.id === x),
  );
  const inferred = inferBrandIcon(id);
  // Upgrade legacy generic category icons automatically when component id clearly matches a known middleware brand.
  const iconId =
    explicit && !GENERIC_SET.has(explicit)
      ? explicit
      : inferred || explicit || di;
  const colorId =
    [color, reg?.color].find((x) => x && COLORS.some((c) => c.id === x)) || dc;
  return { icon: iconId, color: COLORS.find((c) => c.id === colorId)! };
}

export const iconShape = (id: string) =>
  (ICONS.find((i) => i.id === id) || ICONS.find((i) => i.id === "container")!)
    .shape;

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
