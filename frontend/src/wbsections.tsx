import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Spin } from "@arco-design/web-react";
import { IconPlus, IconSearch } from "@arco-design/web-react/icon";
import { stringify, parse } from "yaml";
import { api } from "./shared";
import type { SearchHit, VersionDetail } from "./shared";
import {
  aiTouched,
  get,
  itemFlags,
  problemsFor,
  setValue,
  useWb,
} from "./wbdoc";
import type { Path } from "./wbdoc";
import { Fields, ListEditor, MapEditor, Section } from "./wbforms";
import { StylePicker } from "./wbstyle";
import type { FieldSpec } from "./wbforms";
import { bi, useLang } from "./i18n";

export const getEffects = () => [
  { value: "read-only", label: bi("只读（不改任何东西）", "Read-only (no changes)") },
  { value: "change", label: bi("会修改", "Modifies state") },
  { value: "disruptive", label: bi("会中断服务", "Disrupts service") },
  { value: "destructive", label: bi("会删除数据", "Deletes data") },
];

export const effectShort = (eff?: string) => {
  switch (eff || "change") {
    case "read-only":
      return bi("只读", "Read-only");
    case "change":
      return bi("会修改", "Modify");
    case "disruptive":
      return bi("会中断服务", "Disruptive");
    case "destructive":
      return bi("会删除数据", "Destructive");
    default:
      return eff || "";
  }
};

const roleOpts = (roles: string[]) =>
  roles.map((r) => ({ value: r, label: r }));

/* ------------------------------------------------------------------ scope */

/** Overlay tabs edit the base component or one version's additions. The path is the same shape either way. */
export function useScope() {
  useLang();
  const { versions } = useWb();
  const [idx, setIdx] = useState(-1);
  const base: Path = idx < 0 ? [] : ["versions", idx];
  const bar = (
    <div className="wb-scope">
      <span>{bi("作用范围", "Scope")}</span>
      <Select
        size="small"
        value={idx}
        onChange={setIdx}
        options={[
          { value: -1, label: bi("全部版本（基础）", "All versions (base)") },
          ...versions.map((v, i) => ({
            value: i,
            label: bi(`仅 ${v} 版`, `${v} only`),
          })),
        ]}
        style={{ width: 170 }}
        aria-label={bi("作用范围", "Scope")}
      />
      <em>
        {idx < 0
          ? bi("这里写的内容对每个版本都生效", "Applies to every version")
          : bi(
              "只对这个版本追加，同 id/key 的条目会覆盖基础里的",
              "Appends to this version only; matching id/key overrides base",
            )}
      </em>
    </div>
  );
  return { base, bar, idx };
}

const flagCount =
  (
    problems: ReturnType<typeof useWb>["problems"],
    _base: Path,
    section: string,
    key: (item: any) => string,
  ) =>
  (item: any) =>
    itemFlags(problems, [section], key(item));

/* ------------------------------------------------------------------ overview */

const namedFields = (): FieldSpec[] => [
  { key: "name", label: bi("名称", "Name"), kind: "text", width: "s" },
  { key: "text", label: bi("说明", "Description"), kind: "text", width: "l" },
];

export function OverviewTab() {
  useLang();
  const { ops } = useWb();
  const js = ops.js;
  const unnamed = bi("（未命名）", "(Untitled)");
  return (
    <>
      <Section
        title={bi("基本信息", "Basic Info")}
        help={bi("显示在组件列表、应用商店和交付手册里。", "Shown in the component catalog, app store, and delivery runbooks.")}
      >
        <div className="wb-ident">
          <span>{bi("组件名", "Component ID")}</span>
          <b className="mono">{js.component}</b>
          <em>
            {bi(
              "组件名是它的身份，不能在草稿里改；想要另一个名字请「复制为新组件」。",
              "The component ID is its permanent identifier and cannot be changed in a draft; use Copy as Custom Component for a different ID.",
            )}
          </em>
        </div>
        <Fields
          path={[]}
          item={js}
          specs={[
            {
              key: "title",
              label: bi("显示名称", "Display Name"),
              kind: "text",
              required: true,
              width: "m",
            },
            {
              key: "category",
              label: bi("分类", "Category"),
              kind: "text",
              required: true,
              width: "m",
              hint: bi(
                "同分类的组件会放在一起，如 数据库、协调服务、负载均衡",
                "Components in the same category are grouped together, e.g. Database, Coordination, Load Balancing",
              ),
            },
            {
              key: "short",
              label: bi("默认实例名", "Default Instance Name"),
              kind: "mono",
              width: "s",
              hint: bi("新建集群时默认给实例起的名字", "Default instance prefix when creating a cluster"),
            },
            {
              key: "data_volume",
              label: bi("数据放在 /data", "Store data under /data"),
              kind: "bool",
              width: "s",
            },
            { key: "summary", label: bi("一句话简介", "Summary"), kind: "area", width: "l" },
            { key: "tags", label: bi("标签", "Tags"), kind: "tags", width: "m" },
            {
              key: "provides",
              label: bi("提供的能力", "Provides"),
              kind: "tags",
              width: "m",
              hint: bi("别的组件用 requires 引用它，如 dcs、l4-lb", "Referenced by other components' requires, e.g. dcs, l4-lb"),
            },
          ]}
        />
      </Section>
      <Section
        title={bi("标识", "Branding")}
        help={bi(
          "列表、应用页和交付里显示的图标与颜色。不选就按分类使用默认的。",
          "Icon and color shown across lists, app pages, and deliveries. Defaults to the category style if unset.",
        )}
      >
        <StylePicker
          id={js.component || "c"}
          category={js.category}
          icon={js.icon}
          color={js.color}
          onChange={(i, c) =>
            ops.batch((d) => {
              setValue(d, ["icon"], i || undefined);
              setValue(d, ["color"], c || undefined);
            })
          }
        />
      </Section>
      <Section
        title={bi("交付能力", "Delivery Capabilities")}
        help={bi(
          "同一组件可以同时支持多种交付方式。发布时会再次核对，发布本身不会执行任何命令。",
          "A component can support multiple delivery modes. Re-checked on publish; publishing never runs commands.",
        )}
      >
        <Fields path={[]} item={{...js,kind:js.kind||"",delivery_modes:js.delivery_modes||(js.kind==="external"?["configuration"]:["offline"])}} specs={[
          {
            key:"delivery_modes",
            label:bi("支持的方式", "Supported Modes"),
            kind:"multi",
            width:"l",
            options:[
              {value:"offline",label:bi("离线部署", "Offline Deploy")},
              {value:"automatic",label:bi("自动执行", "Automatic Execution")},
              {value:"configuration",label:bi("仅出配置", "Config Only")},
            ],
            hint:bi(
              "自动执行需为每一步填写超时、完成条件和判据；仅出配置需定义下方的配置文件。",
              "Automatic execution requires timeouts, postconditions, and checks on each step; Config Only requires configuration files below.",
            ),
          },
          {
            key:"kind",
            label:bi("服务由谁管理", "Managed By"),
            kind:"select",
            width:"l",
            options:[
              {value:"",label:bi("平台部署的软件", "Platform-deployed software")},
              {value:"external",label:bi("由现场管理员配置的外部服务", "External service configured by operators")},
            ],
          }
        ]}/>
        <h3 className="wb-sub">{bi("配置文件", "Configuration Files")}</h3>
        <p className="muted small">
          {bi(
            "仅出配置时，按实例和机器分别生成文件。内容支持参数、集群和机器占位符，不执行脚本。",
            "In Config Only mode, files are rendered per instance and host. Supports parameter, cluster, and host placeholders without running scripts.",
          )}
        </p>
        <ListEditor path={["configuration"]} noun={bi("配置文件", "Config File")} fields={[
          {key:"path",label:bi("输出文件名", "Output Path"),kind:"mono",width:"l",required:true,placeholder:"redis.conf"},
          {
            key:"content",
            label:bi("配置内容", "File Content"),
            kind:"area",
            width:"l",
            required:true,
            hint:bi(
              "支持 ${cluster}、${instance}、${params.参数键}、${host.name}、${host.ip}、${host.data_root}。",
              "Supports ${cluster}, ${instance}, ${params.<key>}, ${host.name}, ${host.ip}, ${host.data_root}.",
            ),
          }
        ]} head={x=>({title:x.path||bi("未命名配置文件", "Untitled config file")})} blank={()=>({path:"",content:""})}/>
      </Section>
      <Section title={bi("产品页", "Catalog Details")} help={bi("只用于展示，不影响生成。", "For display only; does not affect generation.")}>
        <Fields
          path={["detail"]}
          item={js.detail || {}}
          specs={[
            { key: "tagline", label: bi("标语", "Tagline"), kind: "text", width: "l" },
            {
              key: "scale",
              label: bi("规模", "Scale"),
              kind: "text",
              width: "m",
              placeholder: bi("如 1–7 台", "e.g. 1–7 nodes"),
            },
            {
              key: "limits",
              label: bi("当前限制", "Limitations"),
              kind: "tags",
              width: "l",
              hint: bi("每条一句，如「不启用自身的 TLS」", "One statement per tag, e.g. \"Built-in TLS disabled\""),
            },
          ]}
        />
        <h3 className="wb-sub">{bi("能力", "Capabilities")}</h3>
        <ListEditor
          path={["detail", "capabilities"]}
          noun={bi("能力", "Capability")}
          fields={namedFields()}
          head={(x) => ({ title: x.name || unnamed, sub: x.text })}
          blank={() => ({ name: "", text: "" })}
        />
        <h3 className="wb-sub">{bi("包含", "Includes")}</h3>
        <ListEditor
          path={["detail", "includes"]}
          noun={bi("内容", "Included Item")}
          fields={namedFields()}
          head={(x) => ({ title: x.name || unnamed, sub: x.text })}
          blank={() => ({ name: "", text: "" })}
        />
      </Section>

    </>
  );
}

export function SchemesTab() {
  useLang();
  const {ops} = useWb();
  const schemes: any[] = ops.js.detail?.presets || [];
  const [selected, select] = useState(0);
  const index = Math.min(selected, Math.max(0, schemes.length - 1));
  return <>
    <p className="muted">
      {bi(
        "一个组件提供多个部署方案。先选择一个系列，只编辑该系列的节点、默认配置和能力；公共参数及实现文件仍由组件复用。",
        "A component can provide multiple deployment schemes. Pick a series to edit its node counts, defaults, and contract; shared parameters and task files are reused.",
      )}
    </p>
    <div className="plans" role="tablist" aria-label={bi("组件部署方案", "Component deployment schemes")}>
      {schemes.map((scheme, i) => <button type="button" key={scheme.id || i} role="tab" aria-selected={i === index} className={i === index ? "plan on" : "plan"} onClick={() => select(i)}>
        <strong>{scheme.name || bi("未命名方案", "Untitled Scheme")}</strong><span>{scheme.spec || scheme.id}</span>
      </button>)}
    </div>
      <Section
        title={bi("当前部署方案", "Selected Deployment Scheme")}
        help={bi(
          "系列、节点、能力和验收共同构成方案契约。填写真实支持的能力；缺少契约或与实现不符时不能发布。",
          "Series, nodes, capabilities, and acceptance form the scheme contract. Document only real capabilities; missing or mismatched contracts block publishing.",
        )}
      >
        <ListEditor
          path={["detail", "presets"]}
          noun={bi("方案", "Scheme")}
          visibleIndex={index}
          onAdded={select}
          defaultOpen
          idKey="id"
          fields={[
            {
              key: "id",
              label: bi("编号", "ID"),
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "name",
              label: bi("名称", "Name"),
              kind: "text",
              width: "s",
              required: true,
            },
            {
              key: "tag",
              label: bi("标签", "Badge"),
              kind: "text",
              width: "s",
              placeholder: bi("推荐 / 开发测试", "Recommended / Dev & Test"),
            },
            {
              key: "spec",
              label: bi("规格说明", "Spec Summary"),
              kind: "text",
              width: "l",
              placeholder: bi("3 台 · 容忍 1 台故障", "3 nodes · tolerates 1 failure"),
            },
          ]}
          head={(x) => ({ title: x.name || x.id, tag: x.tag, sub: x.spec })}
          blank={() => ({ id: "plan", name: bi("新方案", "New Scheme"), roles: [], contract: {operations: ["deploy"]} })}
          extra={(item, p) => <PresetRoles path={p} item={item} />}
        />
      </Section>
  </>;
}

function PresetRoles({ path, item }: { path: Path; item: any }) {
  useLang();
  const { roles, ops, readOnly } = useWb();
  const rows: { role: string; count: number }[] = item.roles || [];
  return (
    <div className="wb-sub-block">
      <h4>{bi("各角色台数", "Role Node Counts")}</h4>
      {rows.map((r, i) => (
        <div className="wb-map-row" key={i}>
          <Select
            disabled={readOnly}
            value={r.role}
            options={roleOpts(roles)}
            onChange={(v) => ops.set([...path, "roles", i, "role"], v)}
            aria-label={bi("角色", "Role")}
          />
          <Input
            disabled={readOnly}
            value={String(r.count ?? "")}
            onChange={(v) =>
              ops.set([...path, "roles", i, "count"], Number(v) || 0)
            }
            aria-label={bi("台数", "Count")}
          />
          {!readOnly && (
            <Button
              size="mini"
              type="text"
              status="danger"
              onClick={() => ops.remove([...path, "roles"], i)}
            >
              {bi("删除", "Delete")}
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          size="mini"
          type="text"
          icon={<IconPlus />}
          onClick={() =>
            ops.add([...path, "roles"], { role: roles[0] || "", count: 1 })
          }
        >
          {bi("添加角色", "Add Role")}
        </Button>
      )}
      <h4>{bi("系列契约", "Series Contract")}</h4>
      <p className="muted small">
        {bi(
          "系列名称须与能力一致。验收引用格式为“组件名/测试ID”；声明测试不代表已在真实环境验收。",
          "Series type must match actual capabilities. Acceptance format is \"component/test-id\"; declaring tests does not imply live environment sign-off.",
        )}
      </p>
      <div className="wb-field w-m wb-contract-series">
        <span className="wb-flabel">{bi("系列类型", "Series Type")}</span>
        <Select aria-label={bi("系列类型", "Series type")} disabled={readOnly} value={item.contract?.series}
          options={[
            {value:"basic",label:bi("基础系列", "Basic")},
            {value:"replication",label:bi("主从系列", "Primary-Replica")},
            {value:"ha",label:bi("高可用系列", "High Availability")},
            {value:"sharded",label:bi("分片集群系列", "Sharded Cluster")},
          ]}
          onChange={(value) => {
            const names: Record<string,string> = {
              basic:bi("基础系列", "Basic"),
              replication:bi("主从系列", "Primary-Replica"),
              ha:bi("高可用系列", "High Availability"),
              sharded:bi("分片集群系列", "Sharded Cluster"),
            };
            ops.batch((doc) => {
              setValue(doc,[...path,"contract","series"],value);
              if (!item.name) setValue(doc,[...path,"name"],names[value]);
            });
          }} />
      </div>
      <Fields path={[...path, "contract"]} item={item.contract || {}} specs={[
        {key:"when",label:bi("系列匹配条件", "Match Expression"),kind:"expr",required:true,width:"l",hint:bi("识别架构，不要绑定内存大小等可调配置", "Identify topology/architecture, not tunable sizing like memory")},
        {key:"failover",label:bi("故障切换", "Failover"),kind:"select",required:true,options:[{value:"none",label:bi("无切换", "None")},{value:"manual",label:bi("人工切换", "Manual")},{value:"automatic",label:bi("自动切换", "Automatic")}]},
        {key:"mechanism",label:bi("实现机制", "Mechanism"),kind:"text",required:true,width:"m",placeholder:bi("例如 Patroni + etcd", "e.g. Patroni + etcd")},
        {key:"read_access",label:bi("读取能力", "Read Access"),kind:"text",required:true,width:"l",placeholder:bi("例如主库读写、从库只读", "e.g. Primary read/write, replica read-only")},
        {key:"sharding",label:bi("提供数据分片", "Supports Sharding"),kind:"bool"},
        {key:"limitations",label:bi("适用限制", "Limitations"),kind:"tags",required:true,width:"l",hint:bi("每条写明一个实际限制", "State one concrete limitation per tag")},
        {key:"acceptance",label:bi("验收测试", "Acceptance Tests"),kind:"tags",required:true,width:"l",placeholder:"postgresql/native-replication"},
        {key:"operations",label:bi("支持操作", "Supported Operations"),kind:"multi",required:true,width:"l",options:[{value:"deploy",label:bi("部署", "Deploy")}]},
      ]}/>
      <h4>{bi("本方案的参数默认值", "Scheme Parameter Overrides")}</h4>
      <p className="muted small">
        {bi(
          "未单独设置的参数沿用公共定义；这里的修改只保存到当前方案。",
          "Unset parameters inherit component defaults; overrides here apply only to this scheme.",
        )}
      </p>
      {Object.keys(item.params || {}).map(key => {
        const def = (ops.js.params || []).find((p: any) => p.key === key);
        return <div key={key} className="wb-scheme-param">
          <Fields path={[...path,"params"]} item={item.params} specs={[{
            key, label: def?.label || key, width:"l",
            kind: def?.type === "cidr-list" ? "tags" : def?.type === "enum" ? "select" : def?.type === "bool" ? "bool" : ["int","port","float"].includes(def?.type) ? "number" : "text",
            options: (def?.options || []).map((v: string) => ({value:v,label:v})),
            hint: def?.hint, min: typeof def?.min === "number" ? def.min : undefined, max: typeof def?.max === "number" ? def.max : undefined,
          }]}/>
          {!readOnly && <Button size="mini" type="text" onClick={() => ops.set([...path,"params",key],undefined)}>{bi("恢复公共默认值", "Reset to default")}</Button>}
        </div>;
      })}
      {!readOnly && <div className="wb-scheme-add"><Select aria-label={bi("添加方案参数", "Add scheme parameter")} placeholder={bi("选择需要单独设置的参数", "Select a parameter to override")} value={undefined} showSearch
        options={(ops.js.params || []).filter((p: any) => !(p.key in (item.params || {}))).map((p: any) => ({value:p.key,label:p.label || p.key}))}
        onChange={(key) => {const def=(ops.js.params || []).find((p: any) => p.key===key);ops.batch(doc => doc.setIn([...path,"params",key],doc.createNode(def?.default ?? "")));}}/></div>}
    </div>
  );
}

/* ------------------------------------------------------------------ versions */

const versionStatuses = () => [
  { value: "draft", label: bi("未发布", "Unpublished") },
  { value: "published", label: bi("已发布", "Published") },
];
const versionStatusTag = (s?: string) =>
  s === "published"
    ? bi("已发布", "Published")
    : bi("未发布", "Unpublished");

export function VersionsTab() {
  useLang();
  const { platforms, versions, problems } = useWb();
  return (
    <>
      <Section
        title={bi("版本", "Versions")}
        help={bi(
          "一个版本就是一套可以装的软件包。后加的版本可以用「继承」只写和前一版不同的地方。",
          "Each version defines an installable set of packages. Newer versions can use Extends to specify only diffs from a prior version.",
        )}
      >
        <ListEditor
          path={["versions"]}
          noun={bi("版本", "Version")}
          idKey="id"
          defaultOpen
          flagged={(x) =>
            problemsFor(problems, (p) => p.startsWith(`versions[${x.id}]`))
              .length
          }
          fields={[
            {
              key: "id",
              label: bi("版本号", "Version ID"),
              kind: "mono",
              width: "s",
              required: true,
              hint: bi("如 3.5、16", "e.g. 3.5, 16"),
            },
            {
              key: "status",
              label: bi("状态", "Status"),
              kind: "select",
              width: "m",
              required: true,
              options: versionStatuses(),
            },
            {
              key: "extends",
              label: bi("继承自", "Extends"),
              kind: "select",
              width: "s",
              options: (item) =>
                versions
                  .filter((v) => v !== item.id)
                  .map((v) => ({ value: v, label: v })),
            },
            {
              key: "platforms",
              label: bi("支持的系统", "Supported OS"),
              kind: "multi",
              width: "l",
              options: platforms.map((p) => ({ value: p.id, label: p.title })),
            },
            {
              key: "released",
              label: bi("发布日期", "Release Date"),
              kind: "mono",
              width: "s",
              hint: bi("如 2026-10-01", "e.g. 2026-10-01"),
            },
            {
              key: "notes",
              label: bi("这个版本带来了什么", "Release Notes"),
              kind: "tags",
              width: "l",
              hint: bi("每条一句，选型时展示给用户", "One line per tag, shown when selecting versions"),
            },
          ]}
          head={(x) => ({
            title: <span className="mono">{x.id}</span>,
            tag: versionStatusTag(x.status),
            sub: bi(
              `${(x.packages || []).length} 个软件包${x.extends ? ` · 继承 ${x.extends}` : ""}`,
              `${(x.packages || []).length} package(s)${x.extends ? ` · extends ${x.extends}` : ""}`,
            ),
          })}
          blank={() => ({
            id: "1.0",
            status: "draft",
            platforms: platforms.slice(0, 1).map((p) => p.id),
            packages: [],
          })}
          extra={(item, p) => <VersionExtra item={item} path={p} />}
        />
      </Section>
      <p className="wb-note">
        {bi(
          "版本里还可以追加参数、步骤、测试等：到对应的页签，把「作用范围」切到这个版本。",
          "You can also override parameters, steps, or tests per version: switch Scope on those tabs to the target version.",
        )}
      </p>
    </>
  );
}

function VersionExtra({ item, path }: { item: any; path: Path }) {
  useLang();
  const { ops, readOnly, platforms } = useWb();
  const pkgs: any[] = item.packages || [];
  const [pick, setPick] = useState(false);
  return (
    <>
      <div className="wb-sub-block">
        <h4>
          {bi("软件包", "Packages")}
          <span>
            {bi(
              "版本必须与软件库里的完全一致；这些包连同依赖会随交付一起带走。",
              "Versions must match the Software Library verbatim; packages and their dependencies are bundled into deliveries.",
            )}
          </span>
        </h4>
        {pkgs.map((pk, i) => (
          <div className="wb-pkg-row" key={i}>
            <Input
              disabled={readOnly}
              className="wb-mono"
              value={pk.name ?? ""}
              placeholder={bi("包名", "Package name")}
              onChange={(v) => ops.set([...path, "packages", i, "name"], v)}
              aria-label={bi("包名", "Package name")}
            />
            <Input
              disabled={readOnly}
              className="wb-mono"
              value={pk.version ?? ""}
              placeholder={bi("版本", "Version")}
              onChange={(v) => ops.set([...path, "packages", i, "version"], v)}
              aria-label={bi("包版本", "Package version")}
            />
            <Input
              disabled={readOnly}
              className="wb-mono"
              value={pk.when ?? ""}
              placeholder={bi("条件（可选）", "Condition (optional)")}
              onChange={(v) => ops.set([...path, "packages", i, "when"], v)}
              aria-label={bi("条件", "Condition")}
            />
            {!readOnly && (
              <Button
                size="mini"
                type="text"
                status="danger"
                onClick={() => ops.remove([...path, "packages"], i)}
              >
                {bi("删除", "Delete")}
              </Button>
            )}
          </div>
        ))}
        {!readOnly && (
          <div className="wb-row-gap">
            <Button
              size="small"
              type="outline"
              icon={<IconSearch />}
              onClick={() => setPick(true)}
            >
              {bi("从软件库选择", "Pick from Library")}
            </Button>
            <Button
              size="small"
              type="text"
              icon={<IconPlus />}
              onClick={() =>
                ops.add([...path, "packages"], { name: "", version: "" })
              }
            >
              {bi("手动添加", "Add Manually")}
            </Button>
          </div>
        )}
      </div>
      <div className="wb-sub-block">
        <h4>
          {bi("离线文件", "Offline Artifacts")}
          <span>
            {bi(
              "不是软件包的文件（安装包、证书等），放在平台的材料库里。",
              "Non-package files (archives, certificates, etc.) stored in the platform artifact store.",
            )}
          </span>
        </h4>
        <ListEditor
          path={[...path, "artifacts"]}
          noun={bi("文件", "Artifact")}
          fields={[
            { key: "name", label: bi("名称", "Name"), kind: "mono", width: "s" },
            {
              key: "kind",
              label: bi("类型", "Kind"),
              kind: "text",
              width: "s",
              placeholder: "file",
            },
            { key: "file", label: bi("文件名", "File"), kind: "mono", width: "m" },
            { key: "sha256", label: "SHA256", kind: "mono", width: "l" },
            { key: "when", label: bi("条件", "Condition"), kind: "expr", width: "l" },
          ]}
          head={(x) => ({ title: x.name || bi("（未命名）", "(Untitled)"), sub: x.file })}
          blank={() => ({ name: "", kind: "file", file: "" })}
        />
      </div>
      <PackagePicker
        open={pick}
        close={() => setPick(false)}
        platform={
          (item.platforms && item.platforms[0]) ||
          platforms[0]?.id ||
          "ubuntu-24.04-amd64"
        }
        platformIds={platforms.map((p) => p.id)}
        onPick={(name, version) => {
          // choosing a package that is already listed (a template's placeholder) sets its version instead of adding another
          const at = pkgs.findIndex((x) => x.name === name);
          if (at >= 0) ops.set([...path, "packages", at, "version"], version);
          else ops.add([...path, "packages"], { name, version });
          setPick(false);
        }}
      />
    </>
  );
}

/** Find a package and one of its versions in the package library's source index. */
function PackagePicker({
  open,
  close,
  platform,
  platformIds,
  onPick,
}: {
  open: boolean;
  close: () => void;
  platform: string;
  platformIds: string[];
  onPick: (n: string, v: string) => void;
}) {
  useLang();
  const [plat, setPlat] = useState(platform);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [chosen, setChosen] = useState<SearchHit | null>(null);
  const [versions, setVersions] = useState<VersionDetail[] | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    if (open) setPlat(platform);
  }, [open, platform]);
  const chooseSeq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    chooseSeq.current++;
    setChosen(null);
    setVersions(null);
    if (term.length < 2) {
      setHits(null);
      setError("");
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api<{ hits: SearchHit[] }>(
        `/api/library/search?platform=${encodeURIComponent(plat)}&q=${encodeURIComponent(term)}`,
      )
        .then((r) => n === seq.current && (setHits(r.hits), setError("")))
        .catch(
          (e) =>
            n === seq.current && (setHits([]), setError((e as Error).message)),
        );
    }, 200);
    return () => clearTimeout(t);
  }, [q, plat]);
  const choose = (h: SearchHit) => {
    const cSeq = ++chooseSeq.current;
    setChosen(h);
    setVersions(null);
    api<{ details: VersionDetail[] }>(
      `/api/library/versions?platform=${encodeURIComponent(plat)}&package=${encodeURIComponent(h.name)}`,
    )
      .then((r) => cSeq === chooseSeq.current && setVersions(r.details))
      .catch((e) => cSeq === chooseSeq.current && setError((e as Error).message));
  };
  return (
    <Modal
      visible={open}
      onCancel={close}
      footer={null}
      title={bi("从软件库选择软件包", "Select Package from Library")}
      style={{ width: 640, maxWidth: "94vw" }}
    >
      <div className="wb-pick">
        <div className="wb-pick-bar">
          <Select
            size="default"
            value={plat}
            onChange={setPlat}
            options={platformIds.map((p) => ({ value: p, label: p }))}
            style={{ width: 190 }}
            aria-label={bi("系统", "OS")}
          />
          <Input
            allowClear
            autoFocus
            prefix={<IconSearch />}
            placeholder={bi("搜索软件包，如 redis、etcd", "Search packages, e.g. redis, etcd")}
            value={q}
            onChange={setQ}
            aria-label={bi("搜索软件包", "Search packages")}
          />
        </div>
        {error && <p className="bad small">{error}</p>}
        <div className="wb-pick-cols">
          <div className="wb-pick-list" role="listbox" aria-label={bi("搜索结果", "Search results")}>
            {hits === null && !error && (
              <p className="muted small">
                {bi(
                  "输入至少两个字符。搜索用的是软件库里的源索引，不需要联网。",
                  "Enter at least 2 characters. Searches local Software Library indexes offline.",
                )}
              </p>
            )}
            {hits?.length === 0 && !error && (
              <p className="muted small">{bi("没有匹配的软件包", "No matching packages")}</p>
            )}
            {hits?.map((h) => (
              <button
                type="button"
                key={h.name}
                role="option"
                aria-selected={chosen?.name === h.name}
                className={chosen?.name === h.name ? "on" : ""}
                onClick={() => choose(h)}
              >
                <b className="mono">{h.name}</b>
                <span>
                  {bi(
                    `最新 ${h.latest} · ${h.versions} 个版本`,
                    `Latest ${h.latest} · ${h.versions} version(s)`,
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="wb-pick-list">
            {!chosen && (
              <p className="muted small">
                {bi("选择左边的软件包，再选一个版本。", "Select a package on the left, then pick a version.")}
              </p>
            )}
            {chosen && !versions && <Spin />}
            {versions?.map((v) => (
              <button
                type="button"
                key={v.version}
                onClick={() => onPick(chosen!.name, v.version)}
              >
                <b className="mono">{v.version}</b>
                <span>
                  {v.suite}
                  {v.have ? bi(" · 已在库", " · Cached") : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ parameters */

const TYPES = [
  "int",
  "float",
  "bool",
  "enum",
  "string",
  "size",
  "port",
  "cidr",
  "cidr-list",
  "ip",
  "host",
].map((v) => ({ value: v, label: v }));

export function ParamsTab() {
  useLang();
  const { problems, groups, roles } = useWb();
  const { base, bar } = useScope();
  const flag = (section: string, key: (x: any) => string) =>
    flagCount(problems, base, section, key);
  return (
    <>
      {bar}
      <Section
        title={bi("参数分组", "Parameter Groups")}
        help={bi("参数在表单里按分组显示。", "Parameters are organized by group in deployment forms.")}
      >
        <ListEditor
          path={[...base, "groups"]}
          noun={bi("分组", "Group")}
          idKey="id"
          fields={[
            {
              key: "id",
              label: bi("编号", "ID"),
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "label",
              label: bi("显示名", "Display Label"),
              kind: "text",
              width: "m",
              required: true,
            },
            {
              key: "scope",
              label: bi("范围", "Scope"),
              kind: "text",
              width: "s",
              hint: bi("留空为实例级", "Blank for instance level"),
            },
            { key: "tab", label: bi("所在页签", "Tab"), kind: "text", width: "s" },
          ]}
          head={(x) => ({
            title: x.label || x.id,
            sub: <span className="mono">{x.id}</span>,
          })}
          blank={() => ({ id: "group", label: bi("新分组", "New Group") })}
        />
      </Section>
      <Section
        title={bi("参数", "Parameters")}
        help={bi(
          "使用者在新建集群时可以调的东西。类型决定了表单里用什么控件，并自动校验范围。",
          "Settings users tune when creating a cluster. Type controls the input widget and automatic range validation.",
        )}
      >
        <ListEditor
          path={[...base, "params"]}
          noun={bi("参数", "Parameter")}
          idKey="key"
          flagged={flag("params", (x) => x.key)}
          fields={PARAM_FIELDS(groups)}
          head={(x) => ({
            title: x.label || x.key,
            tag: x.type,
            sub: <span className="mono">{x.key}</span>,
          })}
          blank={() => ({
            key: "new_param",
            label: bi("新参数", "New Parameter"),
            type: "string",
            group: groups[0]?.id,
          })}
        />
      </Section>
      <Section
        title={bi("校验规则", "Validation Rules")}
        help={bi(
          "几个参数之间必须满足的关系。表达式为真才算通过；写警告则只提醒不拦截。",
          "Cross-parameter constraints. Passes when expression is true; warning-only rules advise without blocking.",
        )}
      >
        <ListEditor
          path={[...base, "rules"]}
          noun={bi("规则", "Rule")}
          idKey="id"
          flagged={flag("rules", (x) => x.id)}
          fields={[
            {
              key: "id",
              label: bi("编号", "ID"),
              kind: "mono",
              width: "s",
              required: true,
            },
            { key: "warn", label: bi("只警告", "Warning only"), kind: "bool", width: "s" },
            {
              key: "expr",
              label: bi("必须成立的表达式", "Expression"),
              kind: "expr",
              width: "l",
              required: true,
            },
            {
              key: "message",
              label: bi("不成立时的提示", "Failure Message"),
              kind: "text",
              width: "l",
              required: true,
            },
          ]}
          head={(x) => ({ title: x.id, sub: x.message })}
          blank={() => ({ id: "rule", expr: "", message: "" })}
        />
      </Section>
      <Section
        title={bi("端口", "Ports")}
        help={bi(
          "声明占用的端口，平台据此检查同一台机器上的冲突。值可以写数字或 =params.xxx。",
          "Declared ports checked for host-level conflicts. Value can be a number or =params.xxx.",
        )}
      >
        <ListEditor
          path={[...base, "ports"]}
          noun={bi("端口", "Port")}
          idKey="name"
          flagged={flag("ports", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: bi("名称", "Name"),
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "value",
              label: bi("端口值", "Port Value"),
              kind: "text",
              loose: true,
              width: "s",
              required: true,
              hint: bi("如 5432 或 =params.client_port", "e.g. 5432 or =params.client_port"),
            },
            {
              key: "proto",
              label: bi("协议", "Protocol"),
              kind: "select",
              width: "s",
              options: [
                { value: "tcp", label: "tcp" },
                { value: "udp", label: "udp" },
              ],
            },
            {
              key: "roles",
              label: bi("哪些角色占用", "Roles"),
              kind: "multi",
              width: "m",
              options: roleOpts(roles),
              hint: bi("留空为每个角色", "Blank for all roles"),
            },
            { key: "when", label: bi("条件", "Condition"), kind: "expr", width: "l" },
          ]}
          head={(x) => ({
            title: x.name,
            sub: <span className="mono">{String(x.value ?? "")}</span>,
          })}
          blank={() => ({ name: "port", value: 8080 })}
        />
      </Section>
    </>
  );
}

const PARAM_FIELDS = (groups: { id: string; label: string }[]): FieldSpec[] => [
  {
    key: "key",
    label: bi("参数 key", "Parameter Key"),
    kind: "mono",
    width: "s",
    required: true,
    hint: bi(
      "小写字母、数字、下划线；roles 里用 mw.params.<key> 引用",
      "Lowercase letters, digits, underscores; referenced as mw.params.<key> in roles",
    ),
  },
  { key: "label", label: bi("显示名", "Display Label"), kind: "text", width: "m", required: true },
  {
    key: "type",
    label: bi("类型", "Type"),
    kind: "select",
    width: "s",
    required: true,
    options: TYPES,
  },
  {
    key: "group",
    label: bi("分组", "Group"),
    kind: "select",
    width: "s",
    options: groups.map((g) => ({ value: g.id, label: g.label })),
  },
  {
    key: "default",
    label: bi("默认值", "Default"),
    kind: "text",
    loose: true,
    width: "s",
    hint: bi("以 = 开头为表达式", "Prefix with = for an expression"),
  },
  {
    key: "unit",
    label: bi("单位", "Unit"),
    kind: "text",
    width: "s",
    placeholder: bi("ms、MB", "ms, MB"),
  },
  {
    key: "min",
    label: bi("最小", "Min"),
    kind: "text",
    loose: true,
    width: "s",
    show: (x) => ["int", "float", "size"].includes(x.type),
  },
  {
    key: "max",
    label: bi("最大", "Max"),
    kind: "text",
    loose: true,
    width: "s",
    show: (x) => ["int", "float", "size"].includes(x.type),
  },
  {
    key: "options",
    label: bi("可选值", "Options"),
    kind: "tags",
    width: "l",
    show: (x) => x.type === "enum",
  },
  {
    key: "pattern",
    label: bi("格式（正则）", "Pattern (regex)"),
    kind: "mono",
    width: "m",
    show: (x) => x.type === "string",
  },
  { key: "hint", label: bi("提示文字", "Hint"), kind: "text", width: "l" },
  { key: "when", label: bi("仅在以下条件下显示", "Visible When"), kind: "expr", width: "l" },
  { key: "required", label: bi("必填", "Required"), kind: "bool", width: "s" },
  { key: "restart", label: bi("修改后需重启", "Restart Required"), kind: "bool", width: "s" },
  { key: "advanced", label: bi("高级", "Advanced"), kind: "bool", width: "s" },
  { key: "locked", label: bi("锁定（由附加项推导）", "Locked (derived by add-ons)"), kind: "bool", width: "s" },
];

/* ------------------------------------------------------------------ relations */

export function RelationsTab() {
  useLang();
  const { roles, problems } = useWb();
  const { base, bar } = useScope();
  const flag = (section: string, key: (x: any) => string) =>
    flagCount(problems, base, section, key);
  return (
    <>
      {bar}
      <Section
        title={bi("角色", "Roles")}
        help={bi(
          "部署时用户给每个角色选机器。「奇数」用于需要多数派的角色；「互斥」表示同一台机器上不能同时扮演另一个互斥角色；「先行」的第一台机器先于其他机器初始化。",
          "Users assign hosts to each role. Odd enforces quorum counts; Exclusive prevents co-locating with other exclusive roles; Initial initializes its first host before others.",
        )}
      >
        <ListEditor
          path={[...base, "roles"]}
          noun={bi("角色", "Role")}
          idKey="name"
          defaultOpen
          flagged={flag("roles", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: bi("角色名", "Role ID"),
              kind: "mono",
              width: "s",
              required: true,
            },
            { key: "title", label: bi("显示名", "Display Label"), kind: "text", width: "s" },
            {
              key: "min",
              label: bi("最少台数", "Min Nodes"),
              kind: "number",
              width: "s",
              min: 0,
            },
            {
              key: "default",
              label: bi("默认台数", "Default Nodes"),
              kind: "number",
              width: "s",
              min: 0,
            },
            {
              key: "max",
              label: bi("硬性上限", "Max Nodes"),
              kind: "number",
              width: "s",
              min: 0,
              hint: bi(
                "只在确实不能更多时填（如主库只能 1 台）；一般留空",
                "Set only for hard caps (e.g. max 1 primary); usually blank",
              ),
            },
            {
              key: "advise",
              label: bi("建议不超过", "Recommended Max"),
              kind: "number",
              width: "s",
              min: 0,
              hint: bi("超过只提示，不阻止", "Warns above this count without blocking"),
            },
            {
              key: "advise_why",
              label: bi("超过时提示", "Advisory Message"),
              kind: "text",
              width: "l",
              show: (x) => !!x.advise,
              placeholder: bi("成员越多写入越慢", "More members slow down writes"),
            },
            {
              key: "odd",
              label: bi("建议奇数", "Prefer Odd Count"),
              kind: "bool",
              width: "s",
              hint: bi("偶数时提示：多数派不增加容错", "Warns on even count: quorum gains no fault tolerance"),
            },
            { key: "exclusive", label: bi("互斥", "Exclusive"), kind: "bool", width: "s" },
            { key: "initial", label: bi("先行", "Initial"), kind: "bool", width: "s" },
          ]}
          head={(x) => ({
            title: x.title || x.name,
            sub: <span className="mono">{x.name}</span>,
            tag: x.max
              ? x.min === x.max
                ? bi(`固定 ${x.max} 台`, `Fixed ${x.max}`)
                : bi(`${x.min ?? 0}–${x.max} 台`, `${x.min ?? 0}–${x.max}`)
              : bi(`${x.min ?? 0} 台起`, `≥ ${x.min ?? 0}`),
          })}
          blank={() => ({ name: "node", title: bi("节点", "Node"), min: 1, default: 1 })}
        />
      </Section>
      <Section
        title={bi("数据流", "Data Flows")}
        help={bi(
          "只用于画拓扑图和手册里的关系说明，不影响生成。镜像（mesh）表示同一角色的成员互相通信，复制（replication）是单向的。",
          "Used only for topology diagrams and runbook documentation. Mesh shows peer communication within a role; replication is directional.",
        )}
      >
        <ListEditor
          path={[...base, "flows"]}
          noun={bi("数据流", "Data Flow")}
          idKey="id"
          flagged={flag("flows", (x) => x.id)}
          fields={[
            {
              key: "id",
              label: bi("编号", "ID"),
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "title",
              label: bi("标题", "Title"),
              kind: "text",
              width: "m",
              required: true,
            },
            {
              key: "kind",
              label: bi("画法", "Kind"),
              kind: "select",
              width: "s",
              required: true,
              options: [
                { value: "replication", label: bi("单向复制", "Replication") },
                { value: "mesh", label: bi("成员互联", "Mesh") },
              ],
            },
            {
              key: "from",
              label: bi("从", "From"),
              kind: "select",
              width: "s",
              required: true,
              options: roleOpts(roles),
            },
            {
              key: "to",
              label: bi("到", "To"),
              kind: "select",
              width: "s",
              required: true,
              options: roleOpts(roles),
            },
            {
              key: "sync",
              label: bi("同步（表达式）", "Sync (expr)"),
              kind: "expr",
              width: "m",
              hint: bi(
                "确认后才继续的写法，如 params.replication == 'quorum' 或 \"true\"",
                "Expression for synchronous mode, e.g. params.replication == 'quorum' or \"true\"",
              ),
            },
            { key: "when", label: bi("存在条件", "Condition"), kind: "expr", width: "l" },
          ]}
          head={(x) => ({
            title: x.title || x.id,
            sub: `${x.from || "?"} → ${x.to || "?"}`,
            tag: x.kind === "mesh" ? bi("互联", "Mesh") : bi("复制", "Replication"),
          })}
          blank={() => ({
            id: "flow",
            title: bi("数据流", "Data Flow"),
            kind: "replication",
            from: roles[0] || "",
            to: roles[1] || roles[0] || "",
          })}
        />
      </Section>
      <Section
        title={bi("依赖", "Dependencies")}
        help={bi(
          "需要别的组件提供的能力。没指定提供者时，平台自动加入「默认实现」。",
          "Capabilities required from other components. Automatically adds the default implementation when none is selected.",
        )}
      >
        <ListEditor
          path={[...base, "requires"]}
          noun={bi("依赖", "Dependency")}
          flagged={flag("requires", (x) => x.capability)}
          fields={[
            {
              key: "capability",
              label: bi("需要的能力", "Capability"),
              kind: "mono",
              width: "s",
              required: true,
              hint: bi("如 dcs、l4-lb", "e.g. dcs, l4-lb"),
            },
            {
              key: "default_impl",
              label: bi("默认实现（组件名）", "Default Implementation"),
              kind: "mono",
              width: "s",
            },
            {
              key: "placement",
              label: bi("默认实现放在哪", "Default Placement"),
              kind: "select",
              width: "s",
              options: [{ value: "same_hosts", label: bi("同一批机器（默认）", "Same hosts (default)") }],
            },
            {
              key: "version",
              label: bi("版本要求", "Version Constraint"),
              kind: "text",
              width: "s",
              placeholder: ">=3.4",
            },
            {
              key: "when",
              label: bi("仅在以下条件下需要", "Required When"),
              kind: "expr",
              width: "l",
            },
          ]}
          head={(x) => ({
            title: <span className="mono">{x.capability || bi("（未填）", "(Unset)")}</span>,
            sub: x.default_impl ? bi(`默认 ${x.default_impl}`, `Default: ${x.default_impl}`) : bi("必须由部署指定", "Must be selected at deploy"),
          })}
          blank={() => ({ capability: "dcs" })}
          extra={(item, p) => (
            <div className="wb-sub-block">
              <h4>
                {bi("传给默认实现的参数", "Parameters for Default Implementation")}
                <span>{bi("以 = 开头为表达式", "Prefix with = for an expression")}</span>
              </h4>
              <MapEditor
                path={[...p, "with"]}
                value={item.with}
                keyLabel={bi("参数 key", "Parameter key")}
              />
            </div>
          )}
        />
      </Section>
      <Section
        title={bi("附加项（可选）", "Add-ons (Optional)")}
        help={bi(
          "数据库扩展之类按对象挂接的增强。部署时用户按对象（例如数据库）选择要装哪些；不选对象就装进默认对象。",
          "Object-scoped extensions such as database extensions. Users select add-ons per target object at deploy time, or fall back to defaults.",
        )}
      >
        <AddonsEditor path={[...base, "addons"]} />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ endpoints */

export function EndpointsTab() {
  useLang();
  const { roles, problems } = useWb();
  const { base, bar } = useScope();
  const flag = (section: string, key: (x: any) => string) =>
    flagCount(problems, base, section, key);
  return (
    <>
      {bar}
      <Section
        title={bi("对外入口", "Endpoints")}
        help={bi(
          "前面的负载均衡要知道往哪转发、怎么判断后端是否健康。同名入口可以按条件有几种写法（单机直连、集群走健康接口）。",
          "Tells load balancers where to forward traffic and how to health-check backends. Multiple conditional definitions may share a name.",
        )}
      >
        <ListEditor
          path={[...base, "endpoints"]}
          noun={bi("入口", "Endpoint")}
          flagged={flag("endpoints", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: bi("名称", "Name"),
              kind: "mono",
              width: "s",
              required: true,
            },
            { key: "title", label: bi("显示名", "Display Label"), kind: "text", width: "m" },
            {
              key: "protocol",
              label: bi("协议", "Protocol"),
              kind: "select",
              width: "s",
              required: true,
              options: [
                { value: "tcp", label: "tcp" },
                { value: "http", label: "http" },
              ],
            },
            {
              key: "port",
              label: bi("端口", "Port"),
              kind: "text",
              loose: true,
              width: "s",
              required: true,
              hint: bi("数字或 =params.xxx", "Number or =params.xxx"),
            },
            {
              key: "backends",
              label: bi("后端角色", "Backend Roles"),
              kind: "multi",
              width: "m",
              required: true,
              options: roleOpts(roles),
            },
            {
              key: "lb",
              label: bi("能否挂负载均衡", "Load Balancer"),
              kind: "select",
              width: "s",
              options: [
                { value: "allowed", label: bi("可以", "Allowed") },
                { value: "discouraged", label: bi("不推荐", "Discouraged") },
                { value: "none", label: bi("不可以", "Disallowed") },
              ],
            },
            { key: "when", label: bi("使用条件", "Condition"), kind: "expr", width: "l" },
            { key: "note", label: bi("给使用者的说明", "User Note"), kind: "text", width: "l" },
          ]}
          head={(x) => ({
            title: x.title || x.name,
            tag: x.protocol,
            sub: (
              <span className="mono">
                {x.name} · {String(x.port ?? "")}
              </span>
            ),
          })}
          blank={() => ({
            name: "service",
            protocol: "tcp",
            port: 8080,
            backends: [],
          })}
          extra={(item, p) => (
            <div className="wb-sub-block">
              <h4>{bi("健康检查", "Health Check")}</h4>
              <Fields
                path={[...p, "health"]}
                item={item.health || {}}
                specs={[
                  {
                    key: "type",
                    label: bi("方式", "Method"),
                    kind: "select",
                    width: "s",
                    options: [
                      { value: "tcp", label: bi("tcp 连接", "TCP connect") },
                      { value: "http", label: bi("http 请求", "HTTP request") },
                      { value: "tcp-script", label: bi("tcp 发送/期望", "TCP send/expect") },
                    ],
                  },
                  {
                    key: "port",
                    label: bi("端口", "Port"),
                    kind: "text",
                    loose: true,
                    width: "s",
                    placeholder: bi("默认同入口", "Defaults to endpoint port"),
                  },
                  {
                    key: "path",
                    label: bi("路径", "Path"),
                    kind: "mono",
                    width: "s",
                    show: (h) => h.type === "http",
                  },
                  {
                    key: "status",
                    label: bi("期望状态码", "Expected Status"),
                    kind: "number",
                    width: "s",
                    show: (h) => h.type === "http",
                  },
                  {
                    key: "send",
                    label: bi("发送", "Send"),
                    kind: "mono",
                    width: "m",
                    show: (h) => h.type === "tcp-script",
                  },
                  {
                    key: "expect",
                    label: bi("期望", "Expect"),
                    kind: "mono",
                    width: "m",
                    show: (h) => h.type === "tcp-script",
                  },
                ]}
              />
            </div>
          )}
        />
      </Section>
      <Section
        title={bi("密钥", "Secrets")}
        help={bi(
          "平台在控制机上自动生成并保存，roles 里用 mw.secrets.<名称> 取；长度是字符数。",
          "Auto-generated on the controller and available in roles via mw.secrets.<name>; length is character count.",
        )}
      >
        <ListEditor
          path={[...base, "secrets"]}
          noun={bi("密钥", "Secret")}
          idKey="name"
          flagged={flag("secrets", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: bi("名称", "Name"),
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "length",
              label: bi("长度", "Length"),
              kind: "number",
              width: "s",
              min: 8,
            },
            {
              key: "when",
              label: bi("仅在以下条件下生成", "Generate When"),
              kind: "expr",
              width: "l",
            },
          ]}
          head={(x) => ({
            title: <span className="mono">{x.name}</span>,
            sub: x.length ? bi(`${x.length} 位`, `${x.length} chars`) : "",
          })}
          blank={() => ({ name: "password", length: 24 })}
        />
      </Section>
      <Section
        title={bi("需要上传的文件", "Required Uploads")}
        help={bi(
          "使用者必须提供的文件，目前支持 TLS 证书包（证书、私钥、CA）。",
          "Files users must upload; currently supports TLS certificate bundles (cert, key, CA).",
        )}
      >
        <ListEditor
          path={[...base, "inputs"]}
          noun={bi("文件", "Upload")}
          idKey="name"
          flagged={flag("inputs", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: bi("名称", "Name"),
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "label",
              label: bi("界面上显示", "Display Label"),
              kind: "text",
              width: "m",
              required: true,
            },
            {
              key: "kind",
              label: bi("种类", "Kind"),
              kind: "select",
              width: "s",
              required: true,
              options: [{ value: "tls-bundle", label: bi("TLS 证书包", "TLS Bundle") }],
            },
            {
              key: "when",
              label: bi("仅在以下条件下需要", "Required When"),
              kind: "expr",
              width: "l",
            },
          ]}
          head={(x) => ({
            title: x.label || x.name,
            sub: <span className="mono">{x.name}</span>,
          })}
          blank={() => ({ name: "tls", label: bi("TLS 证书", "TLS Certificate"), kind: "tls-bundle" })}
        />
      </Section>
      <Section
        title={bi("负载均衡能力（可选）", "Load Balancer Capabilities (Optional)")}
        help={bi(
          "只有提供 l4-lb 的组件才写：声明自己能处理的协议和健康检查方式。",
          "Only for components providing l4-lb: declare supported protocols and health checks.",
        )}
      >
        <LBEditor path={[...base, "lb"]} />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ raw blocks */

/** A part of the manifest without its own form: a small YAML editor that writes back when it parses. */
/** What a load balancer implementation can do: the protocols it forwards and the health checks it runs. */
function LBEditor({ path }: { path: Path }) {
  useLang();
  const { ops } = useWb();
  const lb = get(ops.js, path) || {};
  return (
    <Fields
      path={path}
      item={lb}
      specs={[
        {
          key: "protocols",
          label: bi("能转发的协议", "Forwarded Protocols"),
          kind: "multi",
          width: "m",
          options: [
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
            { value: "http", label: "HTTP" },
          ],
        },
        {
          key: "health",
          label: bi("支持的健康检查", "Supported Health Checks"),
          kind: "multi",
          width: "m",
          options: [
            { value: "tcp", label: bi("TCP 连通", "TCP Connect") },
            { value: "http", label: bi("HTTP 状态", "HTTP Status") },
            { value: "tcp-script", label: bi("TCP 收发脚本", "TCP Send/Expect") },
          ],
        },
      ]}
    />
  );
}

/** The add-ons a component offers (database extensions and the like): what they attach to, and each one. */
function AddonsEditor({ path }: { path: Path }) {
  useLang();
  const { ops } = useWb();
  const set = get(ops.js, path) || {};
  return (
    <div className="wb-addons">
      <Fields
        path={path}
        item={set}
        specs={[
          {
            key: "kind",
            label: bi("类型", "Kind"),
            kind: "mono",
            width: "s",
            placeholder: "pg-extension",
            hint: bi("由组件的任务文件解释，例如 pg-extension", "Interpreted by component task files, e.g. pg-extension"),
          },
        ]}
      />
      <Fields
        path={[...path, "scope"]}
        item={set.scope || {}}
        specs={[
          {
            key: "name",
            label: bi("挂接的对象", "Target Object"),
            kind: "text",
            width: "s",
            placeholder: "database",
            hint: bi("部署表单里让用户选的对象，例如 database", "Target object users select in the deploy form, e.g. database"),
          },
          {
            key: "defaults",
            label: bi("默认对象", "Default Targets"),
            kind: "tags",
            width: "m",
            hint: bi("用户没有选时装进这些，例如 postgres、template1", "Used when none selected, e.g. postgres, template1"),
          },
        ]}
      />
      <ListEditor
        path={[...path, "items"]}
        noun={bi("附加项", "Add-on")}
        idKey="id"
        head={(x) => ({
          title: x.title || x.id || bi("（未命名）", "(Untitled)"),
          sub: x.title ? x.id : undefined,
          tag: x.builtin ? bi("内置", "Built-in") : x.contrib ? "contrib" : undefined,
        })}
        blank={() => ({ id: "new-addon", contrib: true })}
        fields={[
          {
            key: "id",
            label: bi("标识", "ID"),
            kind: "mono",
            width: "s",
            required: true,
          },
          { key: "title", label: bi("显示名", "Display Label"), kind: "text", width: "m" },
          {
            key: "contrib",
            label: bi("随软件自带（contrib）", "Bundled (contrib)"),
            kind: "bool",
            width: "s",
          },
          {
            key: "builtin",
            label: bi("已默认启用", "Enabled by Default"),
            kind: "bool",
            width: "s",
          },
          {
            key: "restart",
            label: bi("启用后要重启", "Restart Required"),
            kind: "bool",
            width: "s",
          },
          {
            key: "since",
            label: bi("从哪个版本起", "Since Version"),
            kind: "mono",
            width: "s",
          },
          { key: "until", label: bi("到哪个版本止", "Until Version"), kind: "mono", width: "s" },
        ]}
        extra={(_x, p) => (
          <div className="wb-sub-block">
            <h4>
              {bi("高级", "Advanced")}
              <span>
                {bi(
                  "附加项自己的参数、要强制设置的实例参数、额外的离线包",
                  "Add-on specific params, forced instance set_params, extra offline artifacts",
                )}
              </span>
            </h4>
            <RawBlock path={[...p, "params"]} label="params" />
            <RawBlock path={[...p, "set_params"]} label="set_params" />
            <RawBlock path={[...p, "artifacts"]} label="artifacts" />
          </div>
        )}
      />
    </div>
  );
}

export function RawBlock({
  path,
  label,
  hideLabel,
}: {
  path: Path;
  label: string;
  hideLabel?: boolean;
}) {
  useLang();
  const { ops, readOnly, aiMarks } = useWb();
  const value = get(ops.js, path);
  const canon =
    value === undefined
      ? ""
      : stringify(value, { lineWidth: 0, flowCollectionPadding: false });
  const [text, setText] = useState(canon);
  const [error, setError] = useState("");
  const last = useRef(canon);
  useEffect(() => {
    if (canon !== last.current) {
      last.current = canon;
      setText(canon);
      setError("");
    }
  }, [canon]);
  const commit = () => {
    try {
      const v = text.trim() ? parse(text) : undefined;
      last.current =
        v === undefined
          ? ""
          : stringify(v, { lineWidth: 0, flowCollectionPadding: false });
      ops.set(path, v);
      setError("");
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    }
  };
  return (
    <div
      className="wb-raw"
      data-wb={path.join(".")}
      data-wb-ai={aiTouched(aiMarks, path) ? "" : undefined}
    >
      {!hideLabel && <span className="wb-flabel">{label}</span>}
      <textarea
        className="wb-raw-text mono"
        disabled={readOnly}
        spellCheck={false}
        rows={Math.min(14, Math.max(3, text.split("\n").length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        aria-label={bi(`${label} 的 YAML`, `YAML for ${label}`)}
        placeholder={bi(`${label}: 留空表示没有`, `${label}: leave blank for none`)}
      />
      {error && (
        <p className="bad small">
          {bi("YAML 有误，未应用：", "Invalid YAML, not applied: ")}
          {error}
        </p>
      )}
    </div>
  );
}
