import { Button, Radio, Select } from "@arco-design/web-react";
import { IconEdit } from "@arco-design/web-react/icon";
import { get, itemFlags, useWb } from "./wbdoc";
import type { Path } from "./wbdoc";
import { Fields, ListEditor, MapEditor, Section } from "./wbforms";
import type { FieldSpec } from "./wbforms";
import { EFFECTS, RawBlock, useScope } from "./wbsections";

export const PHASES: [string, string, string][] = [
  ["preflight", "预检", "动手前的只读核对：端口、磁盘、系统版本"],
  ["install", "安装", "安装软件包、创建目录和用户"],
  ["configure", "配置", "写配置文件、系统服务单元"],
  ["start", "启动", "启动服务并等它就绪；首次组建集群也在这里"],
  ["provision", "初始化", "建库建用户、导入初始数据、注册到其他组件"],
  ["verify", "复核", "部署完成后的只读复核"],
];

const TASK_KEYWORDS = new Set([
  "name",
  "when",
  "register",
  "loop",
  "loop_control",
  "become",
  "become_user",
  "no_log",
  "vars",
  "tags",
  "delegate_to",
  "run_once",
  "changed_when",
  "failed_when",
  "retries",
  "delay",
  "until",
  "notify",
  "args",
  "environment",
  "check_mode",
  "async",
  "poll",
  "throttle",
  "timeout",
]);

const MODULES: { id: string; label: string }[] = [
  { id: "command", label: "command · 运行一条命令（不经过 shell）" },
  { id: "script", label: "script · 把 files/ 里的脚本传过去运行" },
  { id: "copy", label: "copy · 写入文件（给出内容或复制）" },
  { id: "template", label: "template · 用模板写入文件" },
  { id: "file", label: "file · 创建目录、改权限、删除" },
  { id: "lineinfile", label: "lineinfile · 确保文件里有某一行" },
  { id: "blockinfile", label: "blockinfile · 确保文件里有一段" },
  { id: "systemd", label: "systemd · 管理服务" },
  { id: "systemd_service", label: "systemd_service · 管理服务（同 systemd）" },
  { id: "service", label: "service · 管理服务（通用）" },
  { id: "wait_for", label: "wait_for · 等端口或文件" },
  { id: "assert", label: "assert · 断言条件，不成立则停止" },
  { id: "debug", label: "debug · 打印信息" },
  { id: "fail", label: "fail · 主动失败并说明原因" },
  { id: "set_fact", label: "set_fact · 设置变量" },
  { id: "stat", label: "stat · 查看文件状态" },
  { id: "slurp", label: "slurp · 读取文件内容" },
  { id: "find", label: "find · 查找文件" },
  { id: "uri", label: "uri · 发 HTTP 请求" },
  { id: "get_url", label: "get_url · 下载文件" },
  { id: "unarchive", label: "unarchive · 解压" },
  { id: "apt", label: "apt · 安装 deb 包" },
  { id: "package", label: "package · 安装软件包（通用）" },
  { id: "user", label: "user · 管理用户" },
  { id: "group", label: "group · 管理用户组" },
  { id: "pause", label: "pause · 暂停" },
  { id: "meta", label: "meta · 控制流程" },
];

const S = (
  key: string,
  label: string,
  kind: FieldSpec["kind"] = "text",
  width: FieldSpec["width"] = "m",
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, kind, width, ...extra });
const STATE_FILE = [
  { value: "directory", label: "目录" },
  { value: "file", label: "文件" },
  { value: "touch", label: "空文件" },
  { value: "absent", label: "删除" },
  { value: "link", label: "链接" },
];
const OWN = [
  S("mode", "权限", "mono", "s", { placeholder: "0644" }),
  S("owner", "属主", "text", "s"),
  S("group", "属组", "text", "s"),
];
const MODULE_FIELDS: Record<string, FieldSpec[]> = {
  copy: [
    S("dest", "目标路径", "mono", "m", { required: true }),
    S("src", "源文件", "mono", "m", { hint: "files/ 下的文件" }),
    S("content", "直接写入的内容", "area", "l"),
    ...OWN,
  ],
  template: [
    S("src", "模板", "mono", "m", {
      required: true,
      hint: "templates/ 下的 .j2",
    }),
    S("dest", "目标路径", "mono", "m", { required: true }),
    ...OWN,
  ],
  file: [
    S("path", "路径", "mono", "m", { required: true }),
    S("state", "状态", "select", "s", { options: STATE_FILE }),
    S("src", "链接目标", "mono", "m", { show: (x) => x.state === "link" }),
    ...OWN,
    S("recurse", "递归", "bool", "s"),
  ],
  lineinfile: [
    S("path", "文件", "mono", "m", { required: true }),
    S("line", "行内容", "mono", "m"),
    S("regexp", "匹配已有行（正则）", "mono", "m"),
    S("state", "状态", "select", "s", {
      options: [
        { value: "present", label: "存在" },
        { value: "absent", label: "不存在" },
      ],
    }),
    S("create", "文件不存在时创建", "bool", "s"),
  ],
  blockinfile: [
    S("path", "文件", "mono", "m", { required: true }),
    S("block", "内容", "area", "l"),
    S("marker", "标记行", "mono", "m", { placeholder: "# {mark} MANAGED" }),
  ],
  systemd: [
    S("name", "服务名", "mono", "m"),
    S("state", "状态", "select", "s", {
      options: ["started", "stopped", "restarted", "reloaded"].map((v) => ({
        value: v,
        label: v,
      })),
    }),
    S("enabled", "开机自启", "bool", "s"),
    S("daemon_reload", "先重载 systemd", "bool", "s"),
    S("masked", "屏蔽", "bool", "s"),
  ],
  wait_for: [
    S("host", "地址", "mono", "m", {
      placeholder: "{{ mw_hosts[inventory_hostname].ip }}",
    }),
    S("port", "端口", "mono", "s", { loose: true }),
    S("path", "或等待文件", "mono", "m"),
    S("timeout", "最长等待（秒）", "number", "s"),
    S("delay", "先等（秒）", "number", "s"),
    S("state", "等什么", "select", "s", {
      options: ["started", "stopped", "present", "absent", "drained"].map(
        (v) => ({ value: v, label: v }),
      ),
    }),
  ],
  assert: [
    S("that", "必须成立（每条一行）", "tags", "l", { required: true }),
    S("fail_msg", "失败时的提示", "text", "l"),
    S("success_msg", "成功时的提示", "text", "l"),
  ],
  debug: [S("msg", "信息", "text", "l")],
  fail: [S("msg", "原因", "text", "l")],
  stat: [S("path", "路径", "mono", "m", { required: true })],
  slurp: [S("src", "文件", "mono", "m", { required: true })],
  find: [
    S("paths", "目录", "mono", "m"),
    S("patterns", "文件名模式", "tags", "m"),
  ],
  uri: [
    S("url", "地址", "mono", "l", { required: true }),
    S("method", "方法", "select", "s", {
      options: ["GET", "POST", "PUT", "DELETE", "HEAD"].map((v) => ({
        value: v,
        label: v,
      })),
    }),
    S("status_code", "期望状态码", "text", "s", { loose: true }),
    S("return_content", "返回内容", "bool", "s"),
  ],
  get_url: [
    S("url", "地址", "mono", "l", { required: true }),
    S("dest", "保存到", "mono", "m", { required: true }),
    S("checksum", "校验", "mono", "m"),
  ],
  unarchive: [
    S("src", "压缩包", "mono", "m", { required: true }),
    S("dest", "解压到", "mono", "m", { required: true }),
    S("remote_src", "压缩包已在目标机上", "bool", "s"),
  ],
  apt: [
    S("name", "包名", "tags", "l"),
    S("state", "状态", "select", "s", {
      options: [
        { value: "present", label: "已安装" },
        { value: "absent", label: "卸载" },
      ],
    }),
    S("update_cache", "先更新索引", "bool", "s"),
  ],
  package: [
    S("name", "包名", "tags", "l"),
    S("state", "状态", "select", "s", {
      options: [
        { value: "present", label: "已安装" },
        { value: "absent", label: "卸载" },
      ],
    }),
  ],
  user: [
    S("name", "用户名", "mono", "s", { required: true }),
    S("state", "状态", "select", "s", {
      options: [
        { value: "present", label: "存在" },
        { value: "absent", label: "删除" },
      ],
    }),
    S("shell", "shell", "mono", "s"),
    S("home", "家目录", "mono", "m"),
    S("system", "系统用户", "bool", "s"),
  ],
  group: [
    S("name", "组名", "mono", "s", { required: true }),
    S("state", "状态", "select", "s", {
      options: [
        { value: "present", label: "存在" },
        { value: "absent", label: "删除" },
      ],
    }),
    S("system", "系统组", "bool", "s"),
  ],
  pause: [S("seconds", "秒", "number", "s"), S("prompt", "提示", "text", "m")],
};
MODULE_FIELDS.service = MODULE_FIELDS.systemd.slice(0, 3);
MODULE_FIELDS.systemd_service = MODULE_FIELDS.systemd;

const COMMAND_FIELDS: FieldSpec[] = [
  S("cmd", "命令", "mono", "l", { required: true }),
  S("chdir", "工作目录", "mono", "m"),
  S("creates", "该文件存在则跳过", "mono", "m"),
  S("removes", "该文件不存在则跳过", "mono", "m"),
];

const taskModule = (t: Record<string, unknown>): string =>
  Object.keys(t || {}).find((k) => !TASK_KEYWORDS.has(k)) || "";
const shortName = (m: string) => m.replace(/^ansible\.builtin\./, "");

/* ---------------------------------------------------------------- inline tasks */

function TaskEditor({ path, task }: { path: Path; task: any }) {
  const { ops, readOnly } = useWb();
  const key = taskModule(task);
  const short = shortName(key);
  const args = task[key];
  const fq = (m: string) => `ansible.builtin.${m}`;

  const switchModule = (m: string) =>
    ops.batch((d) => {
      const node = d.getIn(path, true) as
        { items: { key: { value: string }; value: unknown }[] } | undefined;
      if (!node) return;
      const old = node.items.find((it) => it.key.value === key);
      if (old) {
        old.key = d.createNode(fq(m)) as never;
        old.value = d.createNode(
          m === "command" || m === "script" ? "" : {},
        ) as never;
      } else
        d.setIn([...path, fq(m)], m === "command" || m === "script" ? "" : {});
    });

  let argsEditor: React.ReactNode = null;
  if (!key) argsEditor = <p className="wb-fhint">选择一个模块。</p>;
  else if (short === "command" || short === "script") {
    const scalar = typeof args === "string";
    argsEditor = scalar ? (
      <div className="wb-field w-l">
        <span className="wb-flabel">
          {short === "command" ? "命令" : "脚本（files/ 下的文件，可带参数）"}
        </span>
        <input
          className="wb-mono arco-input arco-input-size-default"
          disabled={readOnly}
          value={args}
          onChange={(e) => ops.set([...path, key], e.target.value)}
          aria-label="命令"
        />
        <span className="wb-fhint">
          需要工作目录或「已存在则跳过」时，
          <button
            type="button"
            className="wb-link"
            onClick={() => ops.set([...path, key], { cmd: args })}
          >
            改用多选项写法
          </button>
        </span>
      </div>
    ) : (
      <Fields path={[...path, key]} item={args || {}} specs={COMMAND_FIELDS} />
    );
  } else if (short === "set_fact")
    argsEditor = (
      <MapEditor path={[...path, key]} value={args} keyLabel="变量名" />
    );
  else if (MODULE_FIELDS[short])
    argsEditor = (
      <Fields
        path={[...path, key]}
        item={args && typeof args === "object" ? args : {}}
        specs={MODULE_FIELDS[short]}
      />
    );
  else argsEditor = <RawBlock path={[...path, key]} label={key} />;

  return (
    <div className="wb-task">
      <div className="wb-grid">
        <div className="wb-field w-l">
          <span className="wb-flabel">
            这一步做什么<i className="req">必填</i>
          </span>
          <input
            className="arco-input arco-input-size-default"
            disabled={readOnly}
            value={task.name ?? ""}
            onChange={(e) => ops.set([...path, "name"], e.target.value)}
            aria-label="任务名称"
          />
        </div>
        <div className="wb-field w-l">
          <span className="wb-flabel">用什么模块</span>
          <Select
            disabled={readOnly}
            showSearch
            value={short || undefined}
            placeholder="选择模块"
            options={MODULES.map((m) => ({ value: m.id, label: m.label }))}
            onChange={switchModule}
            aria-label="模块"
          />
        </div>
      </div>
      {argsEditor}
      <details className="wb-more">
        <summary>更多选项（条件、重试、结果判断）</summary>
        <Fields
          path={path}
          item={task}
          specs={[
            S("when", "只在以下条件下执行", "expr", "l"),
            S("register", "结果存到变量", "mono", "s"),
            S("changed_when", "何时算「有改动」", "expr", "m", {
              hint: "只读检查常写 false",
            }),
            S("failed_when", "何时算失败", "expr", "m"),
            S("retries", "重试次数", "number", "s", { min: 0 }),
            S("delay", "重试间隔（秒）", "number", "s", { min: 0 }),
            S("until", "直到（表达式）", "expr", "m"),
            S("no_log", "不打印内容（含密码时）", "bool", "s"),
            S("run_once", "只在一台上执行", "bool", "s"),
            S("delegate_to", "改在这台上执行", "mono", "m"),
          ]}
        />
        <h4 className="wb-minor">循环（loop）</h4>
        <RawBlock path={[...path, "loop"]} label="loop" />
      </details>
    </div>
  );
}

function InlineTasks({ path }: { path: Path }) {
  return (
    <div className="wb-sub-block">
      <h4>
        任务
        <span>
          按顺序在选中的机器上执行；只能用上面列出的内置模块。更复杂的逻辑请写成角色任务文件。
        </span>
      </h4>
      <ListEditor
        path={[...path, "tasks"]}
        noun="任务"
        defaultOpen
        fields={[]}
        head={(x) => ({
          title: x.name || "（未命名）",
          sub: <span className="mono">{shortName(taskModule(x))}</span>,
        })}
        blank={() => ({ name: "新任务", "ansible.builtin.command": "" })}
        extra={(item, p) => <TaskEditor path={p} task={item} />}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- run a role file */

function RunEditor({ path, step }: { path: Path; step: any }) {
  const { tasks, openFile, ops, readOnly } = useWb();
  const run = step.run || {};
  const roles = Array.from(
    new Set([...Object.keys(tasks), "mw_packages"]),
  ).sort();
  const files = tasks[run.role] || [];
  return (
    <div className="wb-sub-block">
      <h4>
        运行角色任务文件
        <span>
          任务文件是在目标机器上执行的 Ansible 任务，放在
          roles/&lt;角色&gt;/tasks/ 下（「文件」页签里编辑）。
        </span>
      </h4>
      <div className="wb-grid">
        <div className="wb-field w-s">
          <span className="wb-flabel">
            角色目录<i className="req">必填</i>
          </span>
          <Select
            disabled={readOnly}
            showSearch
            allowCreate
            value={run.role || undefined}
            options={roles.map((r) => ({ value: r, label: r }))}
            onChange={(v) => ops.set([...path, "run", "role"], v)}
            aria-label="角色目录"
          />
        </div>
        <div className="wb-field w-s">
          <span className="wb-flabel">
            任务文件<i className="req">必填</i>
          </span>
          <Select
            disabled={readOnly}
            showSearch
            allowCreate
            value={run.tasks || undefined}
            options={files.map((r) => ({ value: r, label: r + ".yml" }))}
            onChange={(v) => ops.set([...path, "run", "tasks"], v)}
            aria-label="任务文件"
          />
        </div>
        <div className="wb-field w-s wb-open">
          {run.role && run.tasks && (
            <Button
              size="small"
              icon={<IconEdit />}
              onClick={() =>
                openFile(`roles/${run.role}/tasks/${run.tasks}.yml`)
              }
            >
              {files.includes(run.tasks) ? "打开文件" : "去创建文件"}
            </Button>
          )}
        </div>
      </div>
      <h4 className="wb-minor">传给任务文件的变量（可选）</h4>
      <MapEditor
        path={[...path, "run", "vars"]}
        value={run.vars}
        keyLabel="变量名"
      />
    </div>
  );
}

/* ---------------------------------------------------------------- a step */

export function stepFields(
  roles: string[],
  phase: boolean,
): FieldSpec[] {
  const hostOpts = [
    { value: "all", label: "all · 全部机器" },
    ...roles.flatMap((r) => [
      { value: r, label: `${r} · 该角色的机器` },
      { value: `first:${r}`, label: `first:${r} · 该角色的第一台` },
    ]),
  ];
  return [
    S("id", "编号", "mono", "s", { required: true, hint: "在同一阶段内唯一" }),
    S("title", "标题", "text", "m", { required: true, hint: "手册里的步骤名" }),
    S("effect", "影响", "select", "s", { options: EFFECTS, required: true }),
    S("desc", "怎么做、为什么", "area", "l", {
      hint: "写给执行的人：这步做什么、不做会怎样",
    }),
    S("expect", "成功的样子", "text", "l", {
      placeholder: "全部端点 healthy，成员数等于计划",
    }),
    S("hosts", "在哪些机器上", "select", "m", {
      options: hostOpts,
      placeholder: "默认：全部机器",
      hint: "角色名、all、first:角色，或用逗号写几个角色",
    }),
    S("serial", "一次几台", "number", "s", {
      min: 0,
      hint: "滚动执行；留空为同时",
    }),
    S("timeout", "超时（秒）", "number", "s", { min: 0 }),
    S("when", "只在以下条件下执行", "expr", "l"),
    S("skip", "不执行时手册里写的原因", "text", "l", { show: (x) => !!x.when }),
    S("scope", "限定入口", "mono", "s", {
      placeholder: "endpoint:writer",
      hint: "仅当该入口前面挂了负载均衡时执行",
      show: () => phase,
    }),
    S("preconditions", "执行前必须满足", "tags", "l", {
      hint: "Ansible 条件表达式，每项回车确认；任意条件不满足时阻止执行。",
    }),
    S("postconditions", "完成后必须满足", "tags", "l", {
      hint: "由平台执行断言，只有全部通过才能记录成功。不要填写 {{ }}。",
    }),
    S("confirm", "需要确认的变量", "tags", "m", {
      hint: "危险步骤的命令里会带这些 -e 参数，必须人工确认",
    }),
  ];
}

export function StepList({
  path,
  noun,
  blankId,
}: {
  path: Path;
  noun: string;
  blankId: string;
}) {
  const { roles, problems, ops } = useWb();
  return (
    <ListEditor
      path={path}
      noun={noun}
      idKey="id"
      flagged={(x) =>
        itemFlags(
          problems,
          path.includes("lifecycle")
            ? path.slice(path.indexOf("lifecycle")).map(String)
            : path.slice(-1).map(String),
          x.id,
        )
      }
      fields={stepFields(roles, true)}
      head={(x) => ({
        title: x.title || x.id,
        tag: EFFECTS.find(
          (e) => e.value === (x.effect || "change"),
        )?.label.split("（")[0],
        sub: (
          <span className="mono">
            {x.id}
            {x.run
              ? ` · ${x.run.role}/${x.run.tasks}`
              : x.tasks
                ? ` · ${x.tasks.length} 个内联任务`
                : ""}
          </span>
        ),
      })}
      blank={() => ({
        id: blankId,
        title: "新步骤",
        effect: "change",
        run: { role: "", tasks: "" },
      })}
      extra={(item, p) => {
        const inline = !item.run && Array.isArray(item.tasks);
        return (
          <>
            <RawBlock path={[...p, "inputs"]} label="步骤输入契约（例如 timeout: {type: int, value: 7200}）" />
            <div className="wb-mode">
              <Radio.Group
                type="button"
                size="small"
                value={inline ? "inline" : "run"}
                onChange={(v) =>
                  ops.batch((d) => {
                    if (v === "inline") {
                      d.deleteIn([...p, "run"]);
                      d.setIn(
                        [...p, "tasks"],
                        d.createNode([
                          { name: "新任务", "ansible.builtin.command": "" },
                        ]),
                      );
                    } else {
                      d.deleteIn([...p, "tasks"]);
                      d.setIn(
                        [...p, "run"],
                        d.createNode({ role: "", tasks: "" }),
                      );
                    }
                  })
                }
                options={[
                  { value: "run", label: "运行角色任务文件" },
                  { value: "inline", label: "直接写任务" },
                ]}
              />
            </div>
            {inline ? (
              <InlineTasks path={p} />
            ) : (
              <RunEditor path={p} step={item} />
            )}
          </>
        );
      }}
    />
  );
}

/* ---------------------------------------------------------------- tabs */

export function StepsTab() {
  const { base, bar } = useScope();
  const { ops, files } = useWb();
  return (
    <>
      {ops.js.kind === "external" && (
        <div className="note wb-banner-inline">
          这个组件的部署方式是“只出配置”：下面的部署步骤会保留，但不会出现在交付和手册里。要使用它们，请到“概览”把部署方式改回“离线部署”。
        </div>
      )}
      {bar}
      <Section
        title="步骤独立性与公共依赖"
        help="每个步骤的文件默认独立。只有确实需要共用的文件才在这里声明；修改公共文件会影响它的使用者。此声明适用于组件的所有版本、部署、测试和清理步骤。"
      >
        <Fields
          path={[]}
          item={ops.js}
          specs={[{
            key: "shared_files", label: "明确共享的文件", kind: "multi", width: "l",
            options: [...new Set<string>([
              ...files.filter((f) => /^(roles|files|templates)\//.test(f)),
              ...(Array.isArray(ops.js.shared_files) ? ops.js.shared_files : []),
            ])].sort().map((f) => ({
              value: f,
              label: files.includes(f) ? f : `${f}（文件已不存在，建议移除）`,
            })),
            hint: "未声明的文件被多个步骤引用时，平台会拒绝发布和生成交付。请优先拆分各步骤的业务代码，不要把所有文件都声明为共享。",
          }]}
        />
      </Section>
      <div className="wb-phases">
        {PHASES.map(([id, title, help]) => {
          const n = (get(ops.js, [...base, "lifecycle", id]) || []).length;
          return (
            <Section
              key={id}
              id={`phase-${id}`}
              title={`${title}（${id}）${n ? ` · ${n}` : ""}`}
              help={help}
            >
              <StepList
                path={[...base, "lifecycle", id]}
                noun="步骤"
                blankId={id === "install" ? "packages" : id}
              />
            </Section>
          );
        })}
      </div>
    </>
  );
}

export function TestsTab() {
  const { base, bar } = useScope();
  return (
    <>
      {bar}
      <Section
        title="功能测试"
        help="部署完成后交给人执行的验收：每一条是一个独立的 playbook，也写进「功能测试」手册。每个中间件的验收标准不同，这里只写这个中间件自己的检查。"
      >
        <StepList path={[...base, "tests"]} noun="测试" blankId="check" />
      </Section>
      <Section
        title="清理"
        help="拆除或回收时的步骤。删除数据的步骤请把「影响」选为「会删除数据」，并填写需要确认的变量，平台会让执行者显式确认。"
      >
        <StepList
          path={[...base, "cleanup"]}
          noun="清理步骤"
          blankId="cleanup"
        />
      </Section>
    </>
  );
}
