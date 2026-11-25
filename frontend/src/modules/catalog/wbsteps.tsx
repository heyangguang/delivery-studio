import { Button, Input, Radio, Select } from "@arco-design/web-react";
import { IconEdit } from "@arco-design/web-react/icon";
import { get, itemFlags, useWb } from "./wbdoc";
import type { Path } from "./wbdoc";
import { Fields, ListEditor, MapEditor, Section } from "./wbforms";
import type { FieldSpec } from "./wbforms";
import { effectShort, getEffects, RawBlock, useScope } from "./wbsections";
import { bi, useLang } from "../../app/i18n";

export const getPhases = (): [string, string, string][] => [
  ["preflight", bi("预检", "Preflight"), bi("动手前的只读核对：端口、磁盘、系统版本", "Read-only checks before starting: ports, disks, OS version")],
  ["install", bi("安装", "Install"), bi("安装软件包、创建目录和用户", "Install packages, create directories and users")],
  ["configure", bi("配置", "Configure"), bi("写配置文件、系统服务单元", "Write configuration files and systemd units")],
  ["start", bi("启动", "Start"), bi("启动服务并等它就绪；首次组建集群也在这里", "Start services and wait until ready; initial cluster formation")],
  ["provision", bi("初始化", "Provision"), bi("建库建用户、导入初始数据、注册到其他组件", "Create databases/users, seed data, register with other components")],
  ["verify", bi("复核", "Verify"), bi("部署完成后的只读复核", "Read-only verification after deployment")],
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

const getModules = (): { id: string; label: string }[] => [
  { id: "command", label: bi("command · 运行一条命令（不经过 shell）", "command · Run a command (without shell)") },
  { id: "script", label: bi("script · 把 files/ 里的脚本传过去运行", "script · Copy and run a script from files/") },
  { id: "copy", label: bi("copy · 写入文件（给出内容或复制）", "copy · Write or copy a file") },
  { id: "template", label: bi("template · 用模板写入文件", "template · Render a template file") },
  { id: "file", label: bi("file · 创建目录、改权限、删除", "file · Manage dirs, permissions, or removal") },
  { id: "lineinfile", label: bi("lineinfile · 确保文件里有某一行", "lineinfile · Ensure a line exists in a file") },
  { id: "blockinfile", label: bi("blockinfile · 确保文件里有一段", "blockinfile · Ensure a block exists in a file") },
  { id: "systemd", label: bi("systemd · 管理服务", "systemd · Manage systemd services") },
  { id: "systemd_service", label: bi("systemd_service · 管理服务（同 systemd）", "systemd_service · Manage systemd services") },
  { id: "service", label: bi("service · 管理服务（通用）", "service · Manage services (generic)") },
  { id: "wait_for", label: bi("wait_for · 等端口或文件", "wait_for · Wait for a port or file") },
  { id: "assert", label: bi("assert · 断言条件，不成立则停止", "assert · Assert condition or fail") },
  { id: "debug", label: bi("debug · 打印信息", "debug · Print debug message") },
  { id: "fail", label: bi("fail · 主动失败并说明原因", "fail · Fail explicitly with a message") },
  { id: "set_fact", label: bi("set_fact · 设置变量", "set_fact · Set host facts/variables") },
  { id: "stat", label: bi("stat · 查看文件状态", "stat · Check file status") },
  { id: "slurp", label: bi("slurp · 读取文件内容", "slurp · Fetch file contents") },
  { id: "find", label: bi("find · 查找文件", "find · Find matching files") },
  { id: "uri", label: bi("uri · 发 HTTP 请求", "uri · Make HTTP requests") },
  { id: "get_url", label: bi("get_url · 下载文件", "get_url · Download a file") },
  { id: "unarchive", label: bi("unarchive · 解压", "unarchive · Extract an archive") },
  { id: "apt", label: bi("apt · 安装 deb 包", "apt · Manage deb packages") },
  { id: "package", label: bi("package · 安装软件包（通用）", "package · Manage packages (generic)") },
  { id: "user", label: bi("user · 管理用户", "user · Manage system users") },
  { id: "group", label: bi("group · 管理用户组", "group · Manage system groups") },
  { id: "pause", label: bi("pause · 暂停", "pause · Pause execution") },
  { id: "meta", label: bi("meta · 控制流程", "meta · Control playbook flow") },
];

const S = (
  key: string,
  label: string,
  kind: FieldSpec["kind"] = "text",
  width: FieldSpec["width"] = "m",
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, kind, width, ...extra });

const getModuleFields = (short: string): FieldSpec[] | undefined => {
  const stateFile = [
    { value: "directory", label: bi("目录", "Directory") },
    { value: "file", label: bi("文件", "File") },
    { value: "touch", label: bi("空文件", "Touch empty file") },
    { value: "absent", label: bi("删除", "Absent (delete)") },
    { value: "link", label: bi("链接", "Symlink") },
  ];
  const own = [
    S("mode", bi("权限", "Mode"), "mono", "s", { placeholder: "0644" }),
    S("owner", bi("属主", "Owner"), "text", "s"),
    S("group", bi("属组", "Group"), "text", "s"),
  ];
  const systemdFields = [
    S("name", bi("服务名", "Service Name"), "mono", "m"),
    S("state", bi("状态", "State"), "select", "s", {
      options: ["started", "stopped", "restarted", "reloaded"].map((v) => ({
        value: v,
        label: v,
      })),
    }),
    S("enabled", bi("开机自启", "Enabled"), "bool", "s"),
    S("daemon_reload", bi("先重载 systemd", "Daemon Reload"), "bool", "s"),
    S("masked", bi("屏蔽", "Masked"), "bool", "s"),
  ];
  const map: Record<string, FieldSpec[]> = {
    copy: [
      S("dest", bi("目标路径", "Destination"), "mono", "m", { required: true }),
      S("src", bi("源文件", "Source"), "mono", "m", { hint: bi("files/ 下的文件", "File under files/") }),
      S("content", bi("直接写入的内容", "Inline Content"), "area", "l"),
      ...own,
    ],
    template: [
      S("src", bi("模板", "Template"), "mono", "m", {
        required: true,
        hint: bi("templates/ 下的 .j2", ".j2 file under templates/"),
      }),
      S("dest", bi("目标路径", "Destination"), "mono", "m", { required: true }),
      ...own,
    ],
    file: [
      S("path", bi("路径", "Path"), "mono", "m", { required: true }),
      S("state", bi("状态", "State"), "select", "s", { options: stateFile }),
      S("src", bi("链接目标", "Symlink Target"), "mono", "m", { show: (x) => x.state === "link" }),
      ...own,
      S("recurse", bi("递归", "Recurse"), "bool", "s"),
    ],
    lineinfile: [
      S("path", bi("文件", "File Path"), "mono", "m", { required: true }),
      S("line", bi("行内容", "Line"), "mono", "m"),
      S("regexp", bi("匹配已有行（正则）", "Match Regexp"), "mono", "m"),
      S("state", bi("状态", "State"), "select", "s", {
        options: [
          { value: "present", label: bi("存在", "Present") },
          { value: "absent", label: bi("不存在", "Absent") },
        ],
      }),
      S("create", bi("文件不存在时创建", "Create if Missing"), "bool", "s"),
    ],
    blockinfile: [
      S("path", bi("文件", "File Path"), "mono", "m", { required: true }),
      S("block", bi("内容", "Block Content"), "area", "l"),
      S("marker", bi("标记行", "Marker"), "mono", "m", { placeholder: "# {mark} MANAGED" }),
    ],
    systemd: systemdFields,
    systemd_service: systemdFields,
    service: systemdFields.slice(0, 3),
    wait_for: [
      S("host", bi("地址", "Host"), "mono", "m", {
        placeholder: "{{ mw_hosts[inventory_hostname].ip }}",
      }),
      S("port", bi("端口", "Port"), "mono", "s", { loose: true }),
      S("path", bi("或等待文件", "Or File Path"), "mono", "m"),
      S("timeout", bi("最长等待（秒）", "Timeout (s)"), "number", "s"),
      S("delay", bi("先等（秒）", "Initial Delay (s)"), "number", "s"),
      S("state", bi("等什么", "State"), "select", "s", {
        options: ["started", "stopped", "present", "absent", "drained"].map(
          (v) => ({ value: v, label: v }),
        ),
      }),
    ],
    assert: [
      S("that", bi("必须成立（每条一行）", "That (conditions)"), "tags", "l", { required: true }),
      S("fail_msg", bi("失败时的提示", "Fail Message"), "text", "l"),
      S("success_msg", bi("成功时的提示", "Success Message"), "text", "l"),
    ],
    debug: [S("msg", bi("信息", "Message"), "text", "l")],
    fail: [S("msg", bi("原因", "Reason"), "text", "l")],
    stat: [S("path", bi("路径", "Path"), "mono", "m", { required: true })],
    slurp: [S("src", bi("文件", "Source File"), "mono", "m", { required: true })],
    find: [
      S("paths", bi("目录", "Paths"), "mono", "m"),
      S("patterns", bi("文件名模式", "Patterns"), "tags", "m"),
    ],
    uri: [
      S("url", bi("地址", "URL"), "mono", "l", { required: true }),
      S("method", bi("方法", "Method"), "select", "s", {
        options: ["GET", "POST", "PUT", "DELETE", "HEAD"].map((v) => ({
          value: v,
          label: v,
        })),
      }),
      S("status_code", bi("期望状态码", "Expected Status"), "text", "s", { loose: true }),
      S("return_content", bi("返回内容", "Return Content"), "bool", "s"),
    ],
    get_url: [
      S("url", bi("地址", "URL"), "mono", "l", { required: true }),
      S("dest", bi("保存到", "Destination"), "mono", "m", { required: true }),
      S("checksum", bi("校验", "Checksum"), "mono", "m"),
    ],
    unarchive: [
      S("src", bi("压缩包", "Archive"), "mono", "m", { required: true }),
      S("dest", bi("解压到", "Destination"), "mono", "m", { required: true }),
      S("remote_src", bi("压缩包已在目标机上", "Archive on Target"), "bool", "s"),
    ],
    apt: [
      S("name", bi("包名", "Packages"), "tags", "l"),
      S("state", bi("状态", "State"), "select", "s", {
        options: [
          { value: "present", label: bi("已安装", "Present") },
          { value: "absent", label: bi("卸载", "Absent") },
        ],
      }),
      S("update_cache", bi("先更新索引", "Update Cache"), "bool", "s"),
    ],
    package: [
      S("name", bi("包名", "Packages"), "tags", "l"),
      S("state", bi("状态", "State"), "select", "s", {
        options: [
          { value: "present", label: bi("已安装", "Present") },
          { value: "absent", label: bi("卸载", "Absent") },
        ],
      }),
    ],
    user: [
      S("name", bi("用户名", "Username"), "mono", "s", { required: true }),
      S("state", bi("状态", "State"), "select", "s", {
        options: [
          { value: "present", label: bi("存在", "Present") },
          { value: "absent", label: bi("删除", "Absent") },
        ],
      }),
      S("shell", "shell", "mono", "s"),
      S("home", bi("家目录", "Home Dir"), "mono", "m"),
      S("system", bi("系统用户", "System User"), "bool", "s"),
    ],
    group: [
      S("name", bi("组名", "Group Name"), "mono", "s", { required: true }),
      S("state", bi("状态", "State"), "select", "s", {
        options: [
          { value: "present", label: bi("存在", "Present") },
          { value: "absent", label: bi("删除", "Absent") },
        ],
      }),
      S("system", bi("系统组", "System Group"), "bool", "s"),
    ],
    pause: [
      S("seconds", bi("秒", "Seconds"), "number", "s"),
      S("prompt", bi("提示", "Prompt"), "text", "m"),
    ],
  };
  return map[short];
};

const getCommandFields = (): FieldSpec[] => [
  S("cmd", bi("命令", "Command"), "mono", "l", { required: true }),
  S("chdir", bi("工作目录", "Working Dir"), "mono", "m"),
  S("creates", bi("该文件存在则跳过", "Skip if Exists (creates)"), "mono", "m"),
  S("removes", bi("该文件不存在则跳过", "Skip if Missing (removes)"), "mono", "m"),
];

const taskModule = (t: Record<string, unknown>): string =>
  Object.keys(t || {}).find((k) => !TASK_KEYWORDS.has(k)) || "";
const shortName = (m: string) => m.replace(/^ansible\.builtin\./, "");

/* ---------------------------------------------------------------- inline tasks */

function TaskEditor({ path, task }: { path: Path; task: any }) {
  useLang();
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

  const modFields = getModuleFields(short);
  let argsEditor: React.ReactNode = null;
  if (!key) argsEditor = <p className="wb-fhint">{bi("选择一个模块。", "Select a module.")}</p>;
  else if (short === "command" || short === "script") {
    const scalar = typeof args === "string";
    argsEditor = scalar ? (
      <div className="wb-field w-l">
        <span className="wb-flabel">
          {short === "command"
            ? bi("命令", "Command")
            : bi("脚本（files/ 下的文件，可带参数）", "Script (file under files/, optional args)")}
        </span>
        <Input
          className="wb-mono"
          disabled={readOnly}
          value={args}
          onChange={(v) => ops.set([...path, key], v)}
          aria-label={bi("命令", "Command")}
        />
        <span className="wb-fhint">
          {bi("需要工作目录或「已存在则跳过」时，", "Need chdir or creates/removes guards? ")}
          <button
            type="button"
            className="wb-link"
            onClick={() => ops.set([...path, key], { cmd: args })}
          >
            {bi("改用多选项写法", "Switch to structured args")}
          </button>
        </span>
      </div>
    ) : (
      <Fields path={[...path, key]} item={args || {}} specs={getCommandFields()} />
    );
  } else if (short === "set_fact")
    argsEditor = (
      <MapEditor path={[...path, key]} value={args} keyLabel={bi("变量名", "Variable")} />
    );
  else if (modFields)
    argsEditor = (
      <Fields
        path={[...path, key]}
        item={args && typeof args === "object" ? args : {}}
        specs={modFields}
      />
    );
  else argsEditor = <RawBlock path={[...path, key]} label={key} />;

  return (
    <div className="wb-task">
      <div className="wb-grid">
        <div className="wb-field w-l">
          <span className="wb-flabel">
            {bi("这一步做什么", "Task Name")}
            <i className="req">{bi("必填", "Required")}</i>
          </span>
          <Input
            disabled={readOnly}
            value={task.name ?? ""}
            onChange={(v) => ops.set([...path, "name"], v)}
            aria-label={bi("任务名称", "Task name")}
          />
        </div>
        <div className="wb-field w-l">
          <span className="wb-flabel">{bi("用什么模块", "Module")}</span>
          <Select
            disabled={readOnly}
            showSearch
            value={short || undefined}
            placeholder={bi("选择模块", "Select module")}
            options={getModules().map((m) => ({ value: m.id, label: m.label }))}
            onChange={switchModule}
            aria-label={bi("模块", "Module")}
          />
        </div>
      </div>
      {argsEditor}
      <details className="wb-more">
        <summary>{bi("更多选项（条件、重试、结果判断）", "More options (when, retries, status checks)")}</summary>
        <Fields
          path={path}
          item={task}
          specs={[
            S("when", bi("只在以下条件下执行", "Execute When"), "expr", "l"),
            S("register", bi("结果存到变量", "Register Variable"), "mono", "s"),
            S("changed_when", bi("何时算「有改动」", "Changed When"), "expr", "m", {
              hint: bi("只读检查常写 false", "Read-only checks typically use false"),
            }),
            S("failed_when", bi("何时算失败", "Failed When"), "expr", "m"),
            S("retries", bi("重试次数", "Retries"), "number", "s", { min: 0 }),
            S("delay", bi("重试间隔（秒）", "Retry Delay (s)"), "number", "s", { min: 0 }),
            S("until", bi("直到（表达式）", "Until (expr)"), "expr", "m"),
            S("no_log", bi("不打印内容（含密码时）", "Suppress Logs (no_log)"), "bool", "s"),
            S("run_once", bi("只在一台上执行", "Run Once"), "bool", "s"),
            S("delegate_to", bi("改在这台上执行", "Delegate To"), "mono", "m"),
          ]}
        />
        <h4 className="wb-minor">{bi("循环（loop）", "Loop")}</h4>
        <RawBlock path={[...path, "loop"]} label="loop" hideLabel />
      </details>
    </div>
  );
}

function InlineTasks({ path }: { path: Path }) {
  useLang();
  return (
    <div className="wb-sub-block">
      <h4>
        {bi("任务", "Tasks")}
        <span>
          {bi(
            "按顺序在选中的机器上执行；只能用上面列出的内置模块。更复杂的逻辑请写成角色任务文件。",
            "Executed sequentially on selected hosts using only the built-in modules above. Use a role task file for complex logic.",
          )}
        </span>
      </h4>
      <ListEditor
        path={[...path, "tasks"]}
        noun={bi("任务", "Task")}
        defaultOpen
        fields={[]}
        head={(x) => ({
          title: x.name || bi("（未命名）", "(Untitled)"),
          sub: <span className="mono">{shortName(taskModule(x))}</span>,
        })}
        blank={() => ({ name: bi("新任务", "New task"), "ansible.builtin.command": "" })}
        extra={(item, p) => <TaskEditor path={p} task={item} />}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- run a role file */

function RunEditor({ path, step }: { path: Path; step: any }) {
  useLang();
  const { tasks, openFile, ops, readOnly } = useWb();
  const run = step.run || {};
  const roles = Array.from(
    new Set([...Object.keys(tasks), "mw_packages"]),
  ).sort();
  const files = tasks[run.role] || [];
  return (
    <div className="wb-sub-block">
      <h4>
        {bi("运行角色任务文件", "Run Role Task File")}
        <span>
          {bi(
            "任务文件是在目标机器上执行的 Ansible 任务，放在 roles/<角色>/tasks/ 下（「文件」页签里编辑）。",
            "Ansible tasks executed on target hosts, stored under roles/<role>/tasks/ (edit in the Files tab).",
          )}
        </span>
      </h4>
      <div className="wb-grid">
        <div className="wb-field w-s">
          <span className="wb-flabel">
            {bi("角色目录", "Role Directory")}
            <i className="req">{bi("必填", "Required")}</i>
          </span>
          <Select
            disabled={readOnly}
            showSearch
            allowCreate
            value={run.role || undefined}
            options={roles.map((r) => ({ value: r, label: r }))}
            onChange={(v) => ops.set([...path, "run", "role"], v)}
            aria-label={bi("角色目录", "Role directory")}
          />
        </div>
        <div className="wb-field w-s">
          <span className="wb-flabel">
            {bi("任务文件", "Task File")}
            <i className="req">{bi("必填", "Required")}</i>
          </span>
          <Select
            disabled={readOnly}
            showSearch
            allowCreate
            value={run.tasks || undefined}
            options={files.map((r) => ({ value: r, label: r + ".yml" }))}
            onChange={(v) => ops.set([...path, "run", "tasks"], v)}
            aria-label={bi("任务文件", "Task file")}
          />
        </div>
        <div className="wb-field w-s wb-open">
          {run.role && run.tasks && (
            <Button
              icon={<IconEdit />}
              onClick={() =>
                openFile(`roles/${run.role}/tasks/${run.tasks}.yml`)
              }
            >
              {files.includes(run.tasks)
                ? bi("打开文件", "Open File")
                : bi("去创建文件", "Create File")}
            </Button>
          )}
        </div>
      </div>
      <h4 className="wb-minor">{bi("传给任务文件的变量（可选）", "Variables Passed to Task File (optional)")}</h4>
      <MapEditor
        path={[...path, "run", "vars"]}
        value={run.vars}
        keyLabel={bi("变量名", "Variable")}
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
    { value: "all", label: bi("all · 全部机器", "all · All hosts") },
    ...roles.flatMap((r) => [
      { value: r, label: bi(`${r} · 该角色的机器`, `${r} · Hosts in role`) },
      { value: `first:${r}`, label: bi(`first:${r} · 该角色的第一台`, `first:${r} · First host in role`) },
    ]),
  ];
  return [
    S("id", bi("编号", "ID"), "mono", "s", {
      required: true,
      hint: bi("在同一阶段内唯一", "Unique within the phase"),
    }),
    S("title", bi("标题", "Title"), "text", "m", {
      required: true,
      hint: bi("手册里的步骤名", "Step title shown in the runbook"),
    }),
    S("effect", bi("影响", "Impact"), "select", "s", {
      options: getEffects(),
      required: true,
    }),
    S("desc", bi("怎么做、为什么", "Details & Rationale"), "area", "l", {
      hint: bi("写给执行的人：这步做什么、不做会怎样", "For operators: what this step does and why it matters"),
    }),
    S("expect", bi("成功的样子", "Expected Outcome"), "text", "l", {
      placeholder: bi("全部端点 healthy，成员数等于计划", "All endpoints healthy; member count matches plan"),
    }),
    S("hosts", bi("在哪些机器上", "Target Hosts"), "select", "m", {
      options: hostOpts,
      placeholder: bi("默认：全部机器", "Default: all hosts"),
      hint: bi("角色名、all、first:角色，或用逗号写几个角色", "Role name, all, first:role, or comma-separated roles"),
    }),
    S("serial", bi("一次几台", "Batch Size (serial)"), "number", "s", {
      min: 0,
      hint: bi("滚动执行；留空为同时", "Rolling execution; blank runs in parallel"),
    }),
    S("timeout", bi("超时（秒）", "Timeout (s)"), "number", "s", { min: 0 }),
    S("when", bi("只在以下条件下执行", "Execute When"), "expr", "l"),
    S("skip", bi("不执行时手册里写的原因", "Skip Note in Runbook"), "text", "l", {
      show: (x) => !!x.when,
    }),
    S("scope", bi("限定入口", "Scope Endpoint"), "mono", "s", {
      placeholder: "endpoint:writer",
      hint: bi("仅当该入口前面挂了负载均衡时执行", "Runs only when this endpoint sits behind a load balancer"),
      show: () => phase,
    }),
    S("preconditions", bi("执行前必须满足", "Preconditions"), "tags", "l", {
      hint: bi(
        "Ansible 条件表达式，每项回车确认；任意条件不满足时阻止执行。",
        "Ansible condition expressions (press Enter per item); blocks execution if any fail.",
      ),
    }),
    S("postconditions", bi("完成后必须满足", "Postconditions"), "tags", "l", {
      hint: bi(
        "由平台执行断言，只有全部通过才能记录成功。不要填写 {{ }}。",
        "Asserted by the platform; all must pass before marking success. Do not enter {{ }}.",
      ),
    }),
    S("confirm", bi("需要确认的变量", "Confirmation Vars"), "tags", "m", {
      hint: bi(
        "危险步骤的命令里会带这些 -e 参数，必须人工确认",
        "Passed as -e parameters requiring explicit operator confirmation",
      ),
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
  useLang();
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
        tag: effectShort(x.effect),
        sub: (
          <span className="mono">
            {x.id}
            {x.run
              ? ` · ${x.run.role}/${x.run.tasks}`
              : x.tasks
                ? bi(` · ${x.tasks.length} 个内联任务`, ` · ${x.tasks.length} inline task(s)`)
                : ""}
          </span>
        ),
      })}
      blank={() => ({
        id: blankId,
        title: bi("新步骤", "New step"),
        effect: "change",
        run: { role: "", tasks: "" },
      })}
      extra={(item, p) => {
        const inline = !item.run && Array.isArray(item.tasks);
        return (
          <>
            <RawBlock
              path={[...p, "inputs"]}
              label={bi(
                "步骤输入契约（例如 timeout: {type: int, value: 7200}）",
                "Step input contract (e.g. timeout: {type: int, value: 7200})",
              )}
            />
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
                          { name: bi("新任务", "New task"), "ansible.builtin.command": "" },
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
                  { value: "run", label: bi("运行角色任务文件", "Role Task File") },
                  { value: "inline", label: bi("直接写任务", "Inline Tasks") },
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
  useLang();
  const { base, bar } = useScope();
  const { ops, files } = useWb();
  return (
    <>
      {ops.js.kind === "external" && (
        <div className="note wb-banner-inline">
          {bi(
            "这个组件的部署方式是“只出配置”：下面的部署步骤会保留，但不会出现在交付和手册里。要使用它们，请到“概览”把部署方式改回“离线部署”。",
            "This component is set to Config Only: steps below are preserved but omitted from deliveries and runbooks. Switch Managed By back to platform-deployed software on Overview to use them.",
          )}
        </div>
      )}
      {bar}
      <Section
        title={bi("步骤独立性与公共依赖", "Step Independence & Shared Files")}
        help={bi(
          "每个步骤的文件默认独立。只有确实需要共用的文件才在这里声明；修改公共文件会影响它的使用者。此声明适用于组件的所有版本、部署、测试和清理步骤。",
          "Step files are isolated by default. Declare files here only if they must be shared across steps; editing a shared file impacts all consumers. Applies to all versions, deploy, test, and cleanup steps.",
        )}
      >
        <Fields
          path={[]}
          item={ops.js}
          specs={[{
            key: "shared_files",
            label: bi("明确共享的文件", "Explicitly Shared Files"),
            kind: "multi",
            width: "l",
            options: [...new Set<string>([
              ...files.filter((f) => /^(roles|files|templates)\//.test(f)),
              ...(Array.isArray(ops.js.shared_files) ? ops.js.shared_files : []),
            ])].sort().map((f) => ({
              value: f,
              label: files.includes(f)
                ? f
                : bi(`${f}（文件已不存在，建议移除）`, `${f} (missing; consider removing)`),
            })),
            hint: bi(
              "未声明的文件被多个步骤引用时，平台会拒绝发布和生成交付。请优先拆分各步骤的业务代码，不要把所有文件都声明为共享。",
              "The platform blocks publishing and delivery generation if an undeclared file is referenced by multiple steps. Split step-specific code instead of marking everything shared.",
            ),
          }]}
        />
      </Section>
      <div className="wb-phases">
        {getPhases().map(([id, title, help]) => {
          const n = (get(ops.js, [...base, "lifecycle", id]) || []).length;
          return (
            <Section
              key={id}
              id={`phase-${id}`}
              title={`${title} (${id})${n ? ` · ${n}` : ""}`}
              help={help}
            >
              <StepList
                path={[...base, "lifecycle", id]}
                noun={bi("步骤", "Step")}
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
  useLang();
  const { base, bar } = useScope();
  return (
    <>
      {bar}
      <Section
        title={bi("功能测试", "Functional Tests")}
        help={bi(
          "部署完成后交给人执行的验收：每一条是一个独立的 playbook，也写进「功能测试」手册。每个中间件的验收标准不同，这里只写这个中间件自己的检查。",
          "Post-deploy acceptance checks: each item generates an independent playbook and appears in the Functional Tests runbook.",
        )}
      >
        <StepList path={[...base, "tests"]} noun={bi("测试", "Test")} blankId="check" />
      </Section>
      <Section
        title={bi("清理", "Cleanup")}
        help={bi(
          "拆除或回收时的步骤。删除数据的步骤请把「影响」选为「会删除数据」，并填写需要确认的变量，平台会让执行者显式确认。",
          "Decommission and teardown steps. Mark data-removing steps as Destructive and list confirmation variables so operators must explicitly confirm.",
        )}
      >
        <StepList
          path={[...base, "cleanup"]}
          noun={bi("清理步骤", "Cleanup Step")}
          blankId="cleanup"
        />
      </Section>
    </>
  );
}
