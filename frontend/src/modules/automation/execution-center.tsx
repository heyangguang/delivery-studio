import React, { useEffect, useState } from "react";
import { IconDesktop, IconThunderbolt } from "@arco-design/web-react/icon";
import { go } from "../../app/router";
import { bi, useLang } from "../../app/i18n";
import { api, can } from "../../shared/shared";
import { UnderlineTabs } from "../../design/ui";
import { ExecutionMonitorPage } from "./monitor";
import { ExecutionNodes } from "./execution-nodes";
import { ExecutionNode, isExecutionNodeOnline } from "./execution-types";
import "./execution-center.css";

export function ExecutionCenterPage({
  view = "runs",
  fleet = "controllers",
  selectedJob,
  initialRun,
  initialStep,
}: {
  view?: "runs" | "nodes";
  fleet?: "controllers" | "agents";
  selectedJob?: string;
  initialRun?: string;
  initialStep?: string;
}) {
  useLang();
  const canViewRuns = can("delivery.view|delivery.execute");
  const canManageNodes = can("execution.manage");
  const canViewNodes = can("execution.manage|delivery.view");
  const effectiveView: "runs" | "nodes" =
    view === "nodes" && canViewNodes
      ? "nodes"
      : canViewRuns
        ? "runs"
        : "nodes";

  const [nodeStats, setNodeStats] = useState<{ online: number; total: number } | null>(null);

  useEffect(() => {
    if (!canManageNodes) return;
    let alive = true;
    const loadCount = () => {
      api<ExecutionNode[]>("/api/settings/execution-nodes")
        .then((list) => {
          if (!alive || !Array.isArray(list)) return;
          setNodeStats({
            online: list.filter(isExecutionNodeOnline).length,
            total: list.length,
          });
        })
        .catch(() => {});
    };
    loadCount();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadCount();
    }, 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [canManageNodes]);

  const tabItems = [
    ...(canViewRuns
      ? [
          {
            value: "runs",
            label: bi("任务监控", "Task Monitor"),
            icon: <IconThunderbolt />,
          },
        ]
      : []),
    ...(canViewNodes
      ? [
          {
            value: "nodes",
            label: bi("执行节点", "Execution Nodes"),
            count: nodeStats && nodeStats.total > 0 ? nodeStats.total : undefined,
            icon: <IconDesktop />,
          },
        ]
      : []),
  ];

  return (
    <div className="ec-shell">
      <div className="ec-subbar">
        <UnderlineTabs
          className="ec-subbar-tabs"
          label={bi("执行中心分区", "Execution center views")}
          value={effectiveView}
          items={tabItems}
          onChange={(next) => {
            if (next === "nodes") {
              go({ name: "executions", view: "nodes" }, { replace: true });
            } else {
              go({ name: "executions", view: "runs" }, { replace: true });
            }
          }}
        />
        {nodeStats && (
          <button
            type="button"
            className={`ec-subbar-pill num ${nodeStats.online > 0 ? "is-on" : ""}`}
            onClick={() =>
              effectiveView !== "nodes" &&
              go({ name: "executions", view: "nodes" }, { replace: true })
            }
            title={bi(
              `当前 ${nodeStats.online}/${nodeStats.total} 台控制机在线`,
              `${nodeStats.online}/${nodeStats.total} controller nodes online`,
            )}
          >
            <i aria-hidden />
            <span>
              {bi(
                `在线节点 ${nodeStats.online}/${nodeStats.total}`,
                `${nodeStats.online}/${nodeStats.total} Online`,
              )}
            </span>
          </button>
        )}
      </div>

      <div className={`ec-body is-${effectiveView}`}>
        {effectiveView === "nodes" ? (
          <ExecutionNodes
            initialFleet={fleet}
            onFleetChange={(nextFleet) =>
              go(
                {
                  name: "executions",
                  view: "nodes",
                  fleet: nextFleet === "agents" ? "agents" : undefined,
                },
                { replace: true },
              )
            }
            onNodeStatsChange={setNodeStats}
          />
        ) : (
          <ExecutionMonitorPage
            selectedJob={selectedJob}
            initialRun={initialRun}
            initialStep={initialStep}
          />
        )}
      </div>
    </div>
  );
}
