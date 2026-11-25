import { useEffect, useRef, useState } from "react";
import { Button } from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconBulb,
  IconCode,
  IconPlus,
} from "@arco-design/web-react/icon";
import type { Session } from "../../shared/shared";
import { can } from "../../shared/shared";
import { go } from "../../app/router";
import { NewComponentModal } from "./wbdialogs";
import { bi, useLang } from "../../app/i18n";
import "./workbench.css";

const Code = ({ file, children }: { file?: string; children: string }) => (
  <figure className="wg-code">
    {file && <figcaption className="mono">{file}</figcaption>}
    <pre className="mono">{children}</pre>
  </figure>
);

const Step = ({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) => (
  <li className="wg-step">
    <span className="wg-n">{n}</span>
    <div>
      <b>{title}</b>
      <div>{children}</div>
    </div>
  </li>
);

const TOC_IDS = ["parts", "who", "role-files", "verify", "flow", "t1", "t2", "t3"] as const;

export function GuidePage({ me }: { me: Session }) {
  useLang();
  const TOC: [string, string][] = [
    ["parts", bi("一个组件由什么组成", "What Makes Up a Component")],
    ["who", bi("谁来写什么", "Who Authors What")],
    ["role-files", bi("角色任务文件是什么", "Role Task Files")],
    ["verify", bi("验证怎么做", "How Verification Works")],
    ["flow", bi("修改的流程", "Editing Workflow")],
    ["t1", bi("教程一：改一个默认值", "Tutorial 1: Change a Default")],
    ["t2", bi("教程二：给 etcd 加一个版本", "Tutorial 2: Add a Version to etcd")],
    ["t3", bi("教程三：做一个 Redis 风格的新组件", "Tutorial 3: Build a Redis-Style Component")],
  ];
  const admin = can("component.edit");
  const [create, setCreate] = useState(false);
  const [active, setActive] = useState("parts");
  const lock = useRef(0);
  // the contents follows the section that is on screen
  useEffect(() => {
    let raf = 0;

    const findScrollParent = (el: HTMLElement): HTMLElement | null => {
      let p = el.parentElement;
      while (
        p &&
        !(
          /(auto|scroll)/.test(getComputedStyle(p).overflowY) &&
          p.scrollHeight > p.clientHeight + 1
        )
      ) {
        p = p.parentElement;
      }
      return p || (document.scrollingElement as HTMLElement | null);
    };

    const compute = () => {
      if (Date.now() < lock.current) return;
      const els = TOC_IDS.map((id) => document.getElementById(id)).filter(
        Boolean,
      ) as HTMLElement[];
      if (!els.length) return;

      const sc = findScrollParent(els[0]);
      const isDoc =
        !sc ||
        sc === document.scrollingElement ||
        sc === document.documentElement ||
        sc === document.body;
      const viewTop = isDoc ? 0 : sc.getBoundingClientRect().top;
      const viewH = isDoc ? window.innerHeight : sc.clientHeight;
      const scrollTop = isDoc ? window.scrollY : sc.scrollTop;
      const maxScroll = sc ? Math.max(0, sc.scrollHeight - viewH) : 0;
      const remaining = Math.max(0, maxScroll - scrollTop);

      if (maxScroll > 2 && remaining <= 6) {
        setActive(els[els.length - 1].id);
        return;
      }

      const baseOffset = Math.min(104, viewH * 0.2);
      const bottomOffset = Math.max(baseOffset, viewH - 24);
      const tailSpan =
        maxScroll > 2 ? Math.min(maxScroll, Math.max(180, viewH * 0.6)) : 0;
      const tailProgress =
        tailSpan > 0 ? Math.max(0, Math.min(1, 1 - remaining / tailSpan)) : 0;
      const anchorY =
        viewTop + baseOffset + tailProgress * (bottomOffset - baseOffset);

      let chosen = els[0];
      for (const el of els) {
        if (el.getBoundingClientRect().top <= anchorY) chosen = el;
      }
      setActive(chosen.id);
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    compute();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, []);
  const jump = (id: string) => {
    lock.current = Date.now() + 700;
    setActive(id);
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="wg enter">
      <Button
        type="text"
        className="wb-back"
        icon={<IconArrowLeft />}
        onClick={() => go({ name: "components" })}
      >
        {bi("组件", "Components")}
      </Button>
      <div className="wg-layout">
        <nav className="wg-toc" aria-label={bi("目录", "Table of contents")}>
          {TOC.map(([id, t]) => (
            <a
              key={id}
              href={`#/components/guide`}
              className={active === id ? "on" : ""}
              aria-current={active === id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jump(id);
              }}
            >
              {t}
            </a>
          ))}
        </nav>
        <article className="wg-main">
          <header className="wg-hero">
            <span className="wg-eyebrow">{bi("组件工作台指南", "Component Workbench Guide")}</span>
            <h1>{bi("怎么编写和修改组件", "How to Build and Customize Components")}</h1>
            <p className="wg-lead">
              {bi(
                "平台本身不认识任何中间件。etcd、HAProxy、PostgreSQL 的一切——参数、装什么包、怎么起、怎么验收——都写在各自的「组件」里。想改默认值、加一个软件版本、接入一个新中间件，都是在工作台里改组件，不需要改平台。",
                "The platform itself has no hardcoded middleware knowledge. Everything for etcd, HAProxy, or PostgreSQL—parameters, packages, startup, and verification—lives inside each component. To change defaults, add a software version, or onboard a new middleware, edit the component in the workbench without touching platform code.",
              )}
            </p>
            <div className="wg-flow" aria-label={bi("组件如何变成交付", "How components become deliveries")}>
              <div className="wg-flow-src">
                <b>{bi("你写的组件", "Your Component")}</b>
                <span>{bi("声明 · 任务 · 模板 · 测试", "Manifest · Tasks · Templates · Tests")}</span>
              </div>
              <i aria-hidden>→</i>
              <div className="wg-flow-mid">
                <b>{bi("平台", "Platform")}</b>
                <span>{bi("校验、拼装、离线打包", "Validate, assemble, bundle offline")}</span>
              </div>
              <i aria-hidden>→</i>
              <div className="wg-flow-out">
                <span>{bi("部署表单", "Deploy Form")}</span>
                <span>{bi("Ansible 脚本", "Ansible Playbooks")}</span>
                <span>{bi("部署与测试手册", "Deploy & Test Runbook")}</span>
              </div>
            </div>
            <div className="wg-quick">
              <a
                href="#/components/guide"
                onClick={(e) => {
                  e.preventDefault();
                  jump("t1");
                }}
              >
                <IconCode />
                <b>{bi("改一个默认值", "Change a Default")}</b>
                <span>{bi("约 5 分钟 · 最常用", "~5 min · Most common")}</span>
              </a>
              <a
                href="#/components/guide"
                onClick={(e) => {
                  e.preventDefault();
                  jump("t2");
                }}
              >
                <IconPlus />
                <b>{bi("给组件加一个版本", "Add a Version")}</b>
                <span>{bi("先让软件库有这个包", "Ensure the package is in the Library first")}</span>
              </a>
              <a
                href="#/components/guide"
                onClick={(e) => {
                  e.preventDefault();
                  jump("t3");
                }}
              >
                <IconBulb />
                <b>{bi("做一个新组件", "Create a New Component")}</b>
                <span>{bi("从模板开始，一步步来", "Start from a template step by step")}</span>
              </a>
            </div>
            <div className="row-gap">
              {admin && (
                <Button type="primary" onClick={() => setCreate(true)}>
                  {bi("新建组件", "New Component")}
                </Button>
              )}
              <Button onClick={() => go({ name: "components" })}>
                {bi("回到组件列表", "Back to Components")}
              </Button>
            </div>
          </header>

          <section id="parts">
            <h2>{bi("一个组件由什么组成", "What Makes Up a Component")}</h2>
            <div className="wg-parts">
              <div>
                <b className="mono">component.yaml</b>
                <p>
                  <em>{bi("声明", "Declaration")}</em>
                  {bi(
                    "：叫什么、有哪些版本、装哪些包、有哪些参数和校验、角色和依赖、部署分几步、怎么测。平台读它生成表单、校验、部署手册和 Ansible 脚本。",
                    ": name, versions, packages, parameters and rules, roles and dependencies, deployment steps, and tests. The platform reads it to generate forms, validation, runbooks, and Ansible playbooks.",
                  )}
                </p>
              </div>
              <div>
                <b className="mono">{bi("roles/<角色>/tasks/*.yml", "roles/<role>/tasks/*.yml")}</b>
                <p>
                  <em>{bi("在机器上做的事", "Actions on target hosts")}</em>
                  {bi(
                    "：写成 Ansible 任务，每个文件对应部署里的一步（安装、配置、启动、检查……）。",
                    ": written as Ansible tasks, with one file per deployment step (install, configure, start, verify...).",
                  )}
                </p>
              </div>
              <div>
                <b className="mono">{bi("templates/ 与 roles/…/templates/", "templates/ & roles/…/templates/")}</b>
                <p>
                  <em>{bi("配置文件模板", "Config templates")}</em>
                  {bi("：.j2 文件，里面用 ", ": .j2 files referencing parameters via ")}
                  <code>{"{{ mw.params.xxx }}"}</code>
                  {bi(
                    " 引用参数，部署时渲染成目标机器上的配置。",
                    ", rendered onto target hosts during deployment.",
                  )}
                </p>
              </div>
              <div>
                <b className="mono">files/</b>
                <p>
                  <em>{bi("原样复制", "Copied verbatim")}</em>
                  {bi("的文件，如脚本、固定的配置片段。", " files such as helper scripts or static config snippets.")}
                </p>
              </div>
            </div>
          </section>

          <section id="who">
            <h2>{bi("谁来写什么", "Who Authors What")}</h2>
            <table className="wg-table">
              <thead>
                <tr>
                  <th>{bi("部分", "Part")}</th>
                  <th>{bi("谁写", "Author")}</th>
                  <th>{bi("说明", "Notes")}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{bi("通用步骤：预检、数据盘、离线软件源、装包、密钥", "Common steps: preflight, data disk, offline repos, packages, secrets")}</td>
                  <td>{bi("平台已经做好", "Built into platform")}</td>
                  <td>
                    {bi("所有组件共用。装包就是一行 ", "Shared across all components. Installing packages is a single ")}
                    <code>include_role: mw_packages</code>
                    {bi("，不用关心离线源。", "; no need to handle offline repos.")}
                  </td>
                </tr>
                <tr>
                  <td>component.yaml</td>
                  <td>{bi("了解这个中间件的人", "Middleware owner")}</td>
                  <td>
                    {bi(
                      "在工作台里用表单填，不必手写 YAML；高级用法在「源码」页签。",
                      "Fill out via workbench forms without hand-writing YAML; advanced edits are available in the Source tab.",
                    )}
                  </td>
                </tr>
                <tr>
                  <td>{bi("任务文件与模板", "Task files & templates")}</td>
                  <td>{bi("了解这个中间件的人", "Middleware owner")}</td>
                  <td>
                    {bi(
                      "只有懂它怎么配置、怎么启动的人写得对。简单的步骤可以不写文件，直接在步骤里「直接写任务」。",
                      "Requires knowing how the middleware is configured and started. Simple steps can skip separate files and use Inline Tasks directly.",
                    )}
                  </td>
                </tr>
                <tr>
                  <td>{bi("验证（功能测试）", "Verification (Functional Tests)")}</td>
                  <td>{bi("了解这个中间件的人", "Middleware owner")}</td>
                  <td>
                    {bi(
                      "每个中间件怎么算「好了」都不一样，所以测试是各组件自己声明的。",
                      "Each middleware defines health differently, so tests are declared by each component.",
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section id="role-files">
            <h2>{bi("角色任务文件是什么", "Role Task Files")}</h2>
            <p>
              {bi("以 etcd 为例。", "For example, in etcd, ")}
              <code>component.yaml</code>
              {bi(" 里「启动」阶段有一步：", " defines a step under the Start phase:")}
            </p>
            <Code file="component.yaml">{`lifecycle:
  start:
    - id: start
      title: ${bi("启动 etcd 成员", "Start etcd members")}
      effect: change
      run: {role: etcd, tasks: start}`}</Code>
            <p>
              <code>run</code> {bi("指向", "points to")} <code>roles/etcd/tasks/start.yml</code>
              {bi("——真正在每台机器上执行的就是这个文件：", "—this is what actually executes on each machine:")}
            </p>
            <Code file="roles/etcd/tasks/start.yml">{`- name: ${bi("启动 etcd", "Start etcd")}
  ansible.builtin.systemd:
    name: etcd
    enabled: true
    state: started

- name: ${bi("等待客户端端口", "Wait for client port")}
  ansible.builtin.wait_for:
    host: "{{ mw_hosts[inventory_hostname].ip }}"
    port: "{{ mw.params.client_port }}"
    timeout: 120`}</Code>
            <p>
              {bi("所以：", "In short: ")}
              <b>
                {bi(
                  "YAML 描述「分哪几步、每步叫什么、影响多大」，任务文件写「这一步具体做什么」",
                  "YAML describes the steps, titles, and impact; task files implement what each step does",
                )}
              </b>
              {bi(
                "。部署手册和 playbook 都由平台按 YAML 生成，二者不会对不上。",
                ". Both the runbook and playbooks are generated from YAML by the platform, so they never drift apart.",
              )}
            </p>
            <p>
              {bi(
                "任务文件里能用哪些变量？在工作台的「文件」页签，编辑器上方的",
                "Need available variables for task files? On the Files tab, ",
              )}
              <b>{bi("变量速查", "Variable Reference")}</b>
              {bi(
                "会按这个组件的参数、角色、密钥列出来。配置模板还可以点",
                " above the editor lists all parameters, roles, and secrets for this component. For config templates, click ",
              )}
              <b>{bi("渲染预览", "Render Preview")}</b>
              {bi("，让 Ansible 用样例机器真的渲染一遍。", " to render the template against sample hosts with Ansible.")}
            </p>
            <p>
              {bi("如果一步很简单（比如只是 ", "If a step is simple (such as ")}
              <code>systemctl reload</code>
              {bi(
                "），不必建文件：步骤里选「直接写任务」，用表单挑模块、填参数。出于安全，直接写的任务只允许内置的安全模块，不能用 ",
                "), you do not need a file: choose Inline Tasks and fill in module fields via the form. For safety, inline tasks only allow safe built-in modules and disallow ",
              )}
              <code>shell</code>.
            </p>
          </section>

          <section id="verify">
            <h2>{bi("验证怎么做", "How Verification Works")}</h2>
            <p>
              {bi("部署完成后交给人执行的验收，写在 ", "Post-deploy acceptance checks live under ")}
              <code>tests</code>
              {bi(
                " 里，每条是一个步骤，既会生成独立的 playbook，也会进入「功能测试」手册。每个中间件的标准不同，所以由组件自己定义，例如 etcd 的两条：",
                "; each entry is a step that generates an individual playbook and appears in the Functional Tests runbook. For example, etcd defines two tests:",
              )}
            </p>
            <Code file="component.yaml">{`tests:
  - id: health
    title: ${bi("集群健康与领导者", "Cluster Health & Leader")}
    effect: read-only
    expect: ${bi("全部端点 healthy，恰好一个 leader。", "All endpoints are healthy with exactly one leader.")}
    run: {role: etcd, tasks: test_health}
  - id: put-get
    title: ${bi("写入读取删除", "Write, Read & Delete")}
    effect: change
    expect: ${bi("读回的值与写入一致，测试键已删除。", "Read value matches write and test key is deleted.")}
    run: {role: etcd, tasks: test_put_get}`}</Code>
            <p>
              <code>effect</code>{" "}
              {bi(
                "说明这条测试会不会改东西（只读 / 会修改……），手册会据此提醒执行者；",
                "states whether the test modifies state (read-only / modifies...), which the runbook highlights to the operator; ",
              )}
              <code>expect</code>{" "}
              {bi(
                "写「成功是什么样」。同样可以用「直接写任务」做简单检查，比如连一下端口。",
                "describes the expected outcome. Simple checks like port probes can also use Inline Tasks.",
              )}
            </p>
            <p className="wg-note">
              {bi("工作台里的「试生成」只能证明", "Trial Generate in the workbench only verifies that ")}
              <b>{bi("生成的脚本结构正确", "the generated script structure is valid")}</b>
              {bi(
                "（并让 Ansible 做语法检查），不能证明脚本在真实机器上跑得通。版本状态因此分三档：草稿 → 待验证 → 已发布；只有在空环境里真正部署并跑通测试后，才应标「已发布」。",
                " (plus Ansible syntax check); it does not prove execution on real hosts. Version statuses therefore have three tiers: Draft → Verifying → Published. Mark a version Published only after deploying to a clean environment and passing all tests.",
              )}
            </p>
          </section>

          <section id="flow">
            <h2>{bi("修改的流程", "Editing Workflow")}</h2>
            <ol className="wg-steps">
              <Step n={1} title={bi("开一份草稿", "Start a Draft")}>
                {bi(
                  "内置组件不能直接改：在组件页点「修改…」（改动存成你自己的版本，组件会标上「已修改」，随时可以恢复内置）或「复制为自定义组件」。自定义组件点「编辑」。",
                  "Built-in components cannot be edited in place: click Modify... (saves your own override marked Modified, which can be reset to built-in anytime) or Copy as Custom Component. For custom components, click Edit.",
                )}
              </Step>
              <Step n={2} title={bi("改，自动保存", "Edit with Auto-Save")}>
                {bi(
                  "在各页签用表单改，或在「文件」「源码」里改文本，两边实时同步。草稿自动保存，发布之前不影响任何交付。",
                  "Use forms across tabs or edit files/YAML in Files or Source—both stay in sync. Drafts auto-save and never affect deliveries until published.",
                )}
              </Step>
              <Step n={3} title={bi("检查与试生成", "Check & Trial Generate")}>
                {bi(
                  "右上角「检查」显示哪里有错，点开可跳到对应行；「试生成」按草稿生成一套样例交付，给你看表单、步骤、手册，以及和已发布版本的差异。",
                  "Check in the top bar highlights issues and jumps right to the line; Trial Generate builds a sample delivery from your draft to inspect forms, steps, runbooks, and diffs against the published version.",
                )}
              </Step>
              <Step n={4} title={bi("发布", "Publish")}>
                {bi(
                  "写一句修订说明发布。之后新建的交付用新内容；已生成的交付不变。每次发布保存为一个修订，可以对照，也可以回到任何一个。",
                  "Enter a revision note and publish. New deliveries use the updated version while existing ones stay unchanged. Each publish creates a revision you can compare or restore anytime.",
                )}
              </Step>
            </ol>
          </section>

          <section id="t1">
            <h2>{bi("教程一：改一个默认值", "Tutorial 1: Change a Default")}</h2>
            <p className="muted">
              {bi(
                "例：把 etcd 的心跳间隔默认值从 100 ms 改成 200 ms。约 5 分钟。",
                "Example: change etcd's default heartbeat interval from 100 ms to 200 ms (~5 minutes).",
              )}
            </p>
            <ol className="wg-steps">
              <Step n={1} title={bi("打开 etcd，点修改", "Open etcd and Click Modify")}>
                {bi(
                  "组件页选 etcd，点「修改…」，再点「修改这个组件」。",
                  "Select etcd in Components, click Modify..., then choose Modify This Component.",
                )}
              </Step>
              <Step n={2} title={bi("改参数", "Update the Parameter")}>
                {bi(
                  "进入「参数」页签，展开「心跳间隔」，把「默认值」改成 ",
                  "Open the Parameters tab, expand Heartbeat Interval, and set Default to ",
                )}
                <code>200</code>
                {bi(
                  "。注意旁边的「最小 / 最大」：默认值必须在范围里，否则右上角会立刻提示。",
                  ". Watch Min / Max nearby: the default must stay within bounds or Check will flag it immediately.",
                )}
              </Step>
              <Step n={3} title={bi("试生成，确认改了什么", "Trial Generate to Verify Diffs")}>
                {bi("点「试生成」→「文件与差异」，能看到生成的 ", "Click Trial Generate → Files & Diffs and confirm ")}
                <code>inventory/group_vars/all.yml</code>
                {bi(
                  " 里心跳间隔从 100 变成 200，其他文件没有变化。",
                  " updates the heartbeat interval from 100 to 200 with no unintended changes.",
                )}
              </Step>
              <Step n={4} title={bi("发布", "Publish")}>
                {bi(
                  "点「发布…」，说明写「心跳默认改 200ms」。以后新建的 etcd 交付默认就是 200。想回到原样？组件页点「恢复内置」。",
                  "Click Publish..., enter a note like \"Set default heartbeat to 200ms\", and publish. Future etcd deliveries will default to 200. Need to revert? Click Reset to Built-in on the component page.",
                )}
              </Step>
            </ol>
            {admin && (
              <Button onClick={() => go({ name: "components", id: "etcd" })}>
                {bi("去打开 etcd", "Open etcd")}
              </Button>
            )}
          </section>

          <section id="t2">
            <h2>{bi("教程二：给 etcd 加一个版本", "Tutorial 2: Add a Version to etcd")}</h2>
            <p className="muted">
              {bi(
                "例：etcd 有了新的 3.6 版本，要让它也能部署。",
                "Example: add support for a new etcd 3.6 release.",
              )}
            </p>
            <ol className="wg-steps">
              <Step n={1} title={bi("先让软件库有这个版本", "Ensure the Package Is in the Software Library")}>
                {bi(
                  "去「软件库」，搜索 etcd-server，选 3.6 的那个版本，看依赖，下载到本地。这样才能生成离线交付。",
                  "Open the Software Library, search for etcd-server, select 3.6, resolve dependencies, and download locally so offline deliveries can bundle it.",
                )}
              </Step>
              <Step n={2} title={bi("开草稿，添加版本", "Start a Draft and Add the Version")}>
                {bi("进入「版本」页签，点「添加版本」：版本号 ", "In the Versions tab, click Add Version: set ID to ")}
                <code>3.6</code>
                {bi("，「继承自」选 ", " and Extends to ")}
                <code>3.5</code>
                {bi("——这样只需写和 3.5 不同的地方。", "—so you only specify what differs from 3.5.")}
              </Step>
              <Step n={3} title={bi("选软件包", "Select Packages")}>
                {bi(
                  "在新版本里点「从软件库选择」，搜 etcd-server 和 etcd-client，各选刚下载的那个版本。包的版本必须与库里完全一致。",
                  "Click Pick from Library under the new version, search for etcd-server and etcd-client, and pick the downloaded versions. Versions must match the library verbatim.",
                )}
              </Step>
              <Step n={4} title={bi("状态先保持「草稿」", "Keep Status as Draft First")}>
                {bi(
                  "新版本没在空环境验证过之前，状态写「草稿」或「待验证」，用它生成交付时平台会提示「不要用于生产」。",
                  "Until verified on a clean environment, leave Status as Draft or Verifying—deliveries built with it will display a non-production warning.",
                )}
              </Step>
              <Step n={5} title={bi("试生成选 3.6，再发布", "Trial Generate with 3.6, Then Publish")}>
                {bi(
                  "「试生成」里把版本切到 3.6，确认能生成；发布。在空环境真正部署并通过测试后，再回来把状态改为「已发布」。",
                  "Switch Version to 3.6 in Trial Generate to verify output, then publish. Once verified in a clean environment, update its status to Published.",
                )}
              </Step>
            </ol>
          </section>

          <section id="t3">
            <h2>{bi("教程三：做一个 Redis 风格的新组件", "Tutorial 3: Build a Redis-Style Component")}</h2>
            <p className="muted">
              {bi(
                "例：主从结构的缓存，一个主节点加若干从节点。",
                "Example: a primary-replica cache with one primary and multiple replicas.",
              )}
            </p>
            <ol className="wg-steps">
              <Step n={1} title={bi("用模板新建", "Create from Template")}>
                {bi("组件页点「新建」，选「主从」模板，填组件名 ", "On Components, click New, choose Primary + Replica, and fill Component ID ")}
                <code>my-redis</code>
                {bi("、软件包名 ", ", Package ")}
                <code>redis-server</code>
                {bi("、服务名 ", ", Service ")}
                <code>redis-server</code>
                {bi("、端口 ", ", Port ")}
                <code>6379</code>
                {bi(
                  "。得到的是一个能直接走完流程的最小组件：装包、写配置、起服务、查端口。",
                  ". This scaffolds a minimal working component covering install, config, service start, and port check.",
                )}
              </Step>
              <Step n={2} title={bi("选真实的软件包版本", "Select Real Package Versions")}>
                {bi(
                  "模板里的版本号是占位符。到「版本」页签，点「从软件库选择」搜 redis-server，选一个版本。",
                  "The template version is a placeholder. On the Versions tab, click Pick from Library, search redis-server, and select a real version.",
                )}
              </Step>
              <Step n={3} title={bi("改配置模板", "Customize Config Template")}>
                {bi("「文件」页签打开 ", "Open ")}
                <code>roles/my-redis/templates/my-redis.conf.j2</code>
                {bi(
                  "，写成 Redis 真正需要的配置。从节点的 ",
                  " in the Files tab and write the real Redis configuration. Replica ",
                )}
                <code>replicaof</code>
                {bi(
                  " 已经由模板按角色写好；点「渲染预览」，选「机器」为 host2 看从节点渲染出来的内容。",
                  " directives are already wired by role; click Render Preview and set host to host2 to inspect the replica config.",
                )}
              </Step>
              <Step n={4} title={bi("加参数", "Add Parameters")}>
                {bi("「参数」页签添加 ", "In Parameters, add ")}
                <code>maxmemory</code>
                {bi("、", ", ")}
                <code>requirepass</code>
                {bi(" 等，在模板里用 ", " etc., and reference them in templates via ")}
                <code>{"{{ mw.params.maxmemory }}"}</code>
                {bi(
                  " 引用。密码类的放进「入口与密钥」的密钥，让平台自动生成，用 ",
                  ". Put generated passwords under Secrets in Endpoints & Secrets and reference them via ",
                )}
                <code>{"{{ mw.secrets.redis_password }}"}</code>
                {bi(" 取。", ".")}
              </Step>
              <Step n={5} title={bi("写这个中间件自己的验证", "Add Component Tests")}>
                {bi("「测试与清理」页签添加测试，选「直接写任务」：用 ", "Under Tests & Cleanup, add a test using Inline Tasks: run ")}
                <code>command</code>
                {bi(" 模块跑 ", " module with ")}
                <code>redis-cli -p {"{{ mw.params.port }}"} ping</code>
                {bi("，更多选项里「何时算有改动」填 ", ", set Changed When under More Options to ")}
                <code>false</code>
                {bi("，再加一个 ", ", and add an ")}
                <code>assert</code>
                {bi(" 断言返回 PONG。", " checking for PONG.")}
              </Step>
              <Step n={6} title={bi("试生成，检查，发布", "Trial Generate, Check, Publish")}>
                {bi(
                  "「试生成」选「一主一从」方案，看拓扑图里有复制箭头、手册里的步骤是否合理；「检查」全绿后发布。真实机器上跑通之前，版本状态保持「草稿」。",
                  "Run Trial Generate with a primary-replica scheme to verify replication arrows in topology and runbook steps; publish once Check is green. Keep version status as Draft until verified on real machines.",
                )}
              </Step>
            </ol>
            {admin && (
              <Button type="primary" onClick={() => setCreate(true)}>
                {bi("现在就试试", "Try It Now")}
              </Button>
            )}
          </section>
        </article>
      </div>
      <NewComponentModal open={create} close={() => setCreate(false)} />
    </div>
  );
}
