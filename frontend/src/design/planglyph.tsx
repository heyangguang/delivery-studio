import type { AppPlan } from "../shared/shared";
import { bi } from "../app/i18n";

export type PlanBadgeTone = "rec" | "ha" | "manual" | "basic";

export type PlanBadgeInfo = {
  label: string;
  tone: PlanBadgeTone;
  recommended: boolean;
};

/** Resolve a consistent, color-coded badge label & semantic tone for any architecture plan. */
export function planBadgeOf(plan: AppPlan): PlanBadgeInfo | null {
  const rawTag = (plan.tag || "").trim();
  const mech = (plan.contract?.mechanism || "").toLowerCase();
  const spec = (plan.spec || "").toLowerCase();
  const failover = (plan.contract?.failover || "").toLowerCase();
  const series = (plan.contract?.series || "").toLowerCase();
  const hasVip =
    /vip|vrrp|keepalived/.test(mech) ||
    /vip/.test(spec) ||
    plan.params?.ha === "keepalived";

  const isRec = /推荐|recommended/i.test(rawTag);
  if (isRec) {
    return { label: rawTag, tone: "rec", recommended: true };
  }

  if (rawTag) {
    if (/核心|自动|高可用|auto|ha|core|prod/i.test(rawTag)) {
      return { label: rawTag, tone: "ha", recommended: false };
    }
    if (/人工|手动|manual/i.test(rawTag)) {
      return { label: rawTag, tone: "manual", recommended: false };
    }
    if (/开发|测试|单机|单节点|基础|dev|test|single|basic/i.test(rawTag)) {
      return { label: rawTag, tone: "basic", recommended: false };
    }
    return {
      label: rawTag,
      tone: failover === "automatic" ? "ha" : failover === "manual" ? "manual" : "basic",
      recommended: false,
    };
  }

  // Fallback badges for plans without an explicit tag (e.g. HAProxy / Nginx / keepalived).
  if (failover === "automatic" || series === "ha") {
    return {
      label: hasVip ? bi("VIP 高可用", "VIP HA") : bi("自动切换", "Auto HA"),
      tone: "ha",
      recommended: false,
    };
  }
  if (failover === "manual" || series === "replication") {
    return {
      label: bi("人工切换", "Manual"),
      tone: "manual",
      recommended: false,
    };
  }
  const total = (plan.topology || []).reduce((s, t) => s + (t.count || 0), 0);
  if (total <= 1 || series === "basic" || failover === "none") {
    return {
      label: bi("单节点", "Single"),
      tone: "basic",
      recommended: false,
    };
  }
  return null;
}

type PlanArchetype =
  | { kind: "standalone" }
  | { kind: "vip-ha" }
  | { kind: "quorum-3" }
  | { kind: "quorum-5" }
  | { kind: "ha-arbiter"; arbiter: "sentinel" | "dcs"; replicas: number }
  | { kind: "replication"; replicas: number }
  | { kind: "peers"; count: number };

function classifyPlan(plan: AppPlan): PlanArchetype {
  const topo = plan.topology || [];
  const countOf = (...roles: string[]) =>
    topo
      .filter((t) => roles.includes(t.role.toLowerCase()))
      .reduce((s, t) => s + (t.count || 0), 0);

  const primary = countOf("primary", "master", "leader");
  const replica = countOf("replica", "slave", "standby", "follower");
  const sentinel = countOf("sentinel", "arbiter");
  const total = topo.reduce((s, t) => s + (t.count || 0), 0);

  const mech = (plan.contract?.mechanism || "").toLowerCase();
  const spec = (plan.spec || "").toLowerCase();
  const failover = (plan.contract?.failover || "").toLowerCase();
  const combined = `${mech} ${spec}`;

  const hasVip =
    /vip|vrrp|keepalived/.test(combined) || plan.params?.ha === "keepalived";
  const hasSentinel = sentinel > 0 || /sentinel|哨兵/.test(combined);
  const hasDcs = /patroni|etcd|dcs|raft|zookeeper|orchestrator/.test(combined);
  const isPeerRole = topo.some((t) =>
    ["member", "peer", "broker", "controller", "voter"].includes(
      t.role.toLowerCase(),
    ),
  );

  if (total <= 1 && primary <= 1 && replica === 0) {
    return { kind: "standalone" };
  }

  if (hasVip && primary === 0 && replica === 0 && total >= 2) {
    return { kind: "vip-ha" };
  }

  if (
    primary === 0 &&
    replica === 0 &&
    total >= 3 &&
    (isPeerRole || /raft|quorum|共识|多数派|etcd|zookeeper|nacos|kraft/.test(combined))
  ) {
    return total >= 5 ? { kind: "quorum-5" } : { kind: "quorum-3" };
  }

  if (primary >= 1 && replica >= 1) {
    if (failover === "automatic" || hasSentinel || hasDcs) {
      return {
        kind: "ha-arbiter",
        arbiter: hasSentinel ? "sentinel" : "dcs",
        replicas: Math.max(1, Math.min(replica, 2)),
      };
    }
    return {
      kind: "replication",
      replicas: Math.max(1, Math.min(replica, 2)),
    };
  }

  if (hasVip && total >= 2) {
    return { kind: "vip-ha" };
  }

  return { kind: "peers", count: Math.max(2, Math.min(total, 4)) };
}

/** Precision miniature server chassis block inside the 64x40 viewBox. */
function ServerCard({
  x,
  y,
  w,
  h,
  lead,
  rx = 3.2,
  compact = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  lead?: boolean;
  rx?: number;
  compact?: boolean;
}) {
  const nodeCls = lead ? "pg-node pg-node-lead" : "pg-node pg-node-peer";
  const ledCls = lead ? "pg-led pg-led-lead" : "pg-led pg-led-peer";
  const barCls = lead ? "pg-bar pg-bar-lead" : "pg-bar pg-bar-peer";

  if (compact) {
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={rx} className={nodeCls} />
        <circle cx={x + 3.4} cy={y + h / 2} r={1.3} className={ledCls} />
        <rect
          x={x + 6}
          y={y + h / 2 - 0.75}
          width={Math.max(3, w - 8.4)}
          height={1.5}
          rx={0.75}
          className={barCls}
        />
      </g>
    );
  }

  const twoRow = h >= 14;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={rx} className={nodeCls} />
      {twoRow ? (
        <>
          <circle cx={x + 4.8} cy={y + h * 0.35} r={1.65} className={ledCls} />
          <rect
            x={x + 8.4}
            y={y + h * 0.35 - 0.85}
            width={Math.max(5, w - 12)}
            height={1.7}
            rx={0.85}
            className={barCls}
          />
          <rect
            x={x + 3.6}
            y={y + h * 0.68 - 0.75}
            width={Math.max(5, w * 0.54)}
            height={1.5}
            rx={0.75}
            className="pg-bar pg-bar-dim"
          />
        </>
      ) : (
        <>
          <circle cx={x + 4.1} cy={y + h / 2} r={1.5} className={ledCls} />
          <rect
            x={x + 7.2}
            y={y + h / 2 - 0.85}
            width={Math.max(4, w - 10.4)}
            height={1.7}
            rx={0.85}
            className={barCls}
          />
        </>
      )}
    </g>
  );
}

/**
 * Miniature semantic infrastructure topology illustration (fixed 64x40 coordinate system).
 * Accurately differentiates standalone, VIP active-standby, 3/5-member Raft consensus,
 * native streaming replication, and Sentinel/Patroni auto-failover clusters.
 */
export function PlanGlyph({
  plan,
  className = "",
}: {
  plan: AppPlan;
  className?: string;
}) {
  const arch = classifyPlan(plan);

  return (
    <svg
      className={`plan-glyph ${className}`.trim()}
      viewBox="0 0 64 40"
      fill="none"
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden="true"
    >
      {arch.kind === "standalone" && (
        <g>
          {/* Grounded single-host blueprint */}
          <path d="M18 33.5 H46" className="pg-ground" />
          <ServerCard x={18} y={9} w={28} h={20} rx={4.2} lead />
          <circle cx={41.2} cy={22.6} r={1.15} className="pg-bar-dim" />
          <circle cx={37.6} cy={22.6} r={1.15} className="pg-bar-dim" />
        </g>
      )}

      {arch.kind === "vip-ha" && (
        <g>
          {/* Active route (solid Kyndryl) + Standby failover route (dashed Teal) */}
          <path d="M29 13.5 C29 17.5, 16 16.5, 16 21.5" className="pg-wire-live" />
          <path d="M35 13.5 C35 17.5, 48 16.5, 48 21.5" className="pg-wire-idle" />
          {/* VRRP heartbeat chord between the two nodes */}
          <path d="M26 28.5 H38" className="pg-wire-sync" />
          <circle cx={32} cy={28.5} r={1.5} className="pg-sync-dot" />
          {/* Floating VIP endpoint badge */}
          <rect x={21.5} y={3.5} width={21} height={10} rx={5} className="pg-vip-pill" />
          <text x={32} y={10.5} textAnchor="middle" className="pg-vip-txt">
            VIP
          </text>
          {/* Active & Standby nodes */}
          <ServerCard x={5.5} y={21.5} w={21} h={14.5} rx={3.5} lead />
          <ServerCard x={37.5} y={21.5} w={21} h={14.5} rx={3.5} />
        </g>
      )}

      {arch.kind === "quorum-3" && (
        <g>
          {/* Consensus triangle mesh underneath */}
          <path d="M32 10.5 L16 30" className="pg-wire-live" />
          <path d="M32 10.5 L48 30" className="pg-wire-live" />
          <path d="M16 30 L48 30" className="pg-wire-sync" />
          <circle cx={32} cy={23.2} r={2.3} className="pg-quorum-core" />
          {/* 3 Peer nodes (Top Leader + 2 Followers) */}
          <ServerCard x={23.5} y={4} w={17} h={11.5} rx={3} lead />
          <ServerCard x={7.5} y={24.5} w={17} h={11.5} rx={3} />
          <ServerCard x={39.5} y={24.5} w={17} h={11.5} rx={3} />
        </g>
      )}

      {arch.kind === "quorum-5" && (
        <g>
          {/* 5-member Raft consensus pentagon + central quorum spokes */}
          <path
            d="M32 7.5 L50 16.5 L43.5 33 L20.5 33 L14 16.5 Z"
            className="pg-wire-mesh"
          />
          <path d="M32 7.5 L50 16.5 M32 7.5 L14 16.5" className="pg-wire-live" />
          <path
            d="M32 7.5 L32 21.5 M50 16.5 L32 21.5 M43.5 33 L32 21.5 M20.5 33 L32 21.5 M14 16.5 L32 21.5"
            className="pg-wire-faint"
          />
          <circle cx={32} cy={21.5} r={2.3} className="pg-quorum-core" />
          {/* 5 Peer nodes positioned cleanly on pentagon vertices */}
          <ServerCard x={26} y={3} w={12} h={9} rx={2.6} lead compact />
          <ServerCard x={44} y={12} w={12} h={8.5} rx={2.5} compact />
          <ServerCard x={37.5} y={28.5} w={12} h={8.5} rx={2.5} compact />
          <ServerCard x={14.5} y={28.5} w={12} h={8.5} rx={2.5} compact />
          <ServerCard x={8} y={12} w={12} h={8.5} rx={2.5} compact />
        </g>
      )}

      {arch.kind === "ha-arbiter" && (
        <g>
          {/* Top Arbiter / Quorum control plane (3 Sentinel diamonds or 3 DCS nodes) */}
          <path d="M18 7.5 H46" className="pg-wire-arbiter" />
          {/* Watch bus down to data tier */}
          <path d="M32 10.5 V17" className="pg-wire-arbiter" />
          <path d="M12 17 H52" className="pg-wire-faint" />
          <path d="M12 17 V22.5 M32 17 V22.5 M52 17 V22.5" className="pg-wire-faint" />

          {[18, 32, 46].map((cx) =>
            arch.arbiter === "sentinel" ? (
              <rect
                key={cx}
                x={cx - 3.1}
                y={4.4}
                width={6.2}
                height={6.2}
                rx={1.3}
                transform={`rotate(45 ${cx} 7.5)`}
                className="pg-arbiter-sen"
              />
            ) : (
              <rect
                key={cx}
                x={cx - 3.4}
                y={4.2}
                width={6.8}
                height={6.6}
                rx={2}
                className="pg-arbiter-dcs"
              />
            ),
          )}

          {/* Data tier: Primary + 2 Replicas with replication links */}
          <path d="M20 29 H24" className="pg-wire-live" />
          <path d="M40 29 H44" className="pg-wire-sync" />
          <ServerCard x={4} y={22.5} w={16} h={13} rx={3} lead />
          <ServerCard x={24} y={22.5} w={16} h={13} rx={3} />
          <ServerCard x={44} y={22.5} w={16} h={13} rx={3} />
        </g>
      )}

      {arch.kind === "replication" && arch.replicas === 1 && (
        <g>
          {/* Streaming replication arrow Primary -> Replica */}
          <path d="M26.5 20 H36.5" className="pg-wire-live" />
          <path d="M33.6 17.2 L36.8 20 L33.6 22.8" className="pg-wire-live" />
          <circle cx={29.8} cy={20} r={1.25} className="pg-led pg-led-lead" />
          <ServerCard x={5} y={11} w={21} h={18} rx={3.8} lead />
          <ServerCard x={38} y={11} w={21} h={18} rx={3.8} />
        </g>
      )}

      {arch.kind === "replication" && arch.replicas >= 2 && (
        <g>
          <path d="M25 20 C31 20, 31 11.5, 38 11.5" className="pg-wire-live" />
          <path d="M25 20 C31 20, 31 28.5, 38 28.5" className="pg-wire-idle" />
          <ServerCard x={5} y={11} w={20} h={18} rx={3.8} lead />
          <ServerCard x={38.5} y={5} w={20} h={13} rx={3.2} />
          <ServerCard x={38.5} y={22} w={20} h={13} rx={3.2} />
        </g>
      )}

      {arch.kind === "peers" && (
        <g>
          {(() => {
            const n = arch.count;
            const w = n >= 4 ? 12 : n === 3 ? 16 : 21;
            const h = n >= 4 ? 13 : 15;
            const gap = n >= 4 ? 3.5 : n === 3 ? 4 : 8;
            const totalW = n * w + (n - 1) * gap;
            const x0 = (64 - totalW) / 2;
            const y0 = (40 - h) / 2;
            return (
              <>
                <path
                  d={`M${x0 + w / 2} 20 H${x0 + totalW - w / 2}`}
                  className="pg-wire-sync"
                />
                {Array.from({ length: n }, (_, i) => (
                  <ServerCard
                    key={i}
                    x={x0 + i * (w + gap)}
                    y={y0}
                    w={w}
                    h={h}
                    rx={3}
                    lead={i === 0}
                    compact={n >= 4}
                  />
                ))}
              </>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

/** Matching 64x40 modular blueprint illustration for the "Custom" card. */
export function PlanGlyphCustom({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`plan-glyph ${className}`.trim()}
      viewBox="0 0 64 40"
      fill="none"
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M28 11.5 H36 M28 28.5 H36 M20 17.5 V22.5 M44 17.5 V22.5" className="pg-wire-faint" />
      <rect x={11} y={5.5} width={17} height={12} rx={3} className="pg-custom-slot" />
      <rect x={36} y={5.5} width={17} height={12} rx={3} className="pg-custom-slot" />
      <rect x={11} y={22.5} width={17} height={12} rx={3} className="pg-custom-slot" />
      <rect x={36} y={22.5} width={17} height={12} rx={3} className="pg-custom-add" />
      <path d="M44.5 25.8 V31.2 M41.8 28.5 H47.2" className="pg-wire-live" />
    </svg>
  );
}
