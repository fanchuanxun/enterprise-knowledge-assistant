/**
 * 访问策略表 —— 服务端权威版本（单一事实来源）。
 *
 * 与 index.html 中的 ACCESS_POLICY 保持同一份语义：角色 → 可见 audience 集合。
 * 差异在于：这里是**服务端强制**的，客户端拿到的文档集在出网前就已经按身份过滤，
 * 越权文档根本不会下发；直接按 id 请求越权文档返回 403。
 */

export const ACCESS_POLICY = {
  employee: { label: "员工", audiences: ["all"] },
  hr: { label: "人事", audiences: ["all", "hr"] },
  manager: { label: "主管", audiences: ["all", "manager"] },
  admin: { label: "管理员", audiences: ["all", "hr", "manager"] },
};

export const AUDIENCE_LABELS = { all: "所有员工", hr: "人事专属", manager: "主管专属" };

export function canAccess(role, doc) {
  const policy = ACCESS_POLICY[role];
  if (!policy) return false;
  return policy.audiences.includes(doc?.audience);
}

export function visibleDocuments(role, documents) {
  return documents.filter((doc) => canAccess(role, doc));
}

export function describeDenial(role, doc, action = "查看") {
  const label = ACCESS_POLICY[role]?.label || role;
  return `身份「${label}」没有${action}该文档的权限（该文档可见范围：${AUDIENCE_LABELS[doc?.audience] || "未知"}）。`;
}
