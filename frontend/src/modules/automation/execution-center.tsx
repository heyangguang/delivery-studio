import React, { useMemo } from "react";
import { Tooltip } from "@arco-design/web-react";
import { IconLink, IconThunderbolt } from "@arco-design/web-react/icon";
import { href } from "../../app/router";
import { bi, useLang } from "../../app/i18n";
import { can } from "../../shared/shared";
import { ExecutionMonitorPage } from "./monitor";
import { ExecutionNodes } from "./execution-nodes";
import "./execution-center.css";

type CenterTab = "runs" | "agents";

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
  const lang = useLang();
  const canViewRuns = can("delivery.view|delivery.execute");
  const canViewNodes = can("execution.manage|delivery.view");

  const activeTab: CenterTab =
    view === "nodes" && canViewNodes
      ? "agents"
      : canViewRuns
        ? "runs"
        : "agents";

  const tabs = useMemo(() => {
    const out: {
      key: CenterTab;
      label: string;
      tip: string;
      to: string;
      icon: React.ReactNode;
    }[] = [];
    if (canViewRuns) {
      out.push({
        key: "runs",
        label: bi("任务监控", "Tasks"),
        tip: bi("实时查看集群自动交付与步骤执行终端日志", "Monitor live delivery & automation runs"),
        to: href({ name: "executions", view: "runs" }),
        icon: <IconThunderbolt />,
      });
    }
    if (canViewNodes) {
      out.push({
        key: "agents",
        label: "Agent",
        tip: bi("统一管理全平台控制机与各集群目标机 Agent", "Manage all control-host and target-host Agents"),
        to: href({ name: "executions", view: "nodes" }),
        icon: <IconLink />,
      });
    }
    return out;
  }, [canViewRuns, canViewNodes, lang]);

  const centerNav =
    tabs.length > 1 ? (
      <nav
        className="ec-rail-tabs"
        aria-label={bi("执行中心模块切换", "Execution center modules")}
      >
        {tabs.map((t) => {
          const on = activeTab === t.key;
          return (
            <Tooltip
              key={t.key}
              position="bottom"
              content={t.tip}
              mini
              triggerProps={{ mouseEnterDelay: 400 }}
            >
              <a
                href={t.to}
                className={`ec-rail-tab tone-${t.key}${on ? " on" : ""}`}
                aria-current={on ? "page" : undefined}
              >
                <span className="ec-rail-tab-ic" aria-hidden>
                  {t.icon}
                </span>
                <span className="ec-rail-tab-lbl">{t.label}</span>
              </a>
            </Tooltip>
          );
        })}
      </nav>
    ) : null;

  if (activeTab === "runs") {
    return (
      <ExecutionMonitorPage
        centerNav={centerNav}
        selectedJob={selectedJob}
        initialRun={initialRun}
        initialStep={initialStep}
      />
    );
  }

  return (
    <ExecutionNodes
      centerNav={centerNav}
      initialRole={fleet === "agents" ? "target" : "all"}
    />
  );
}
