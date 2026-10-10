/**
 * 评测判定逻辑（纯函数，无浏览器依赖）。
 *
 * 单独抽出来的原因：判定口径是「118/118 这个数字可不可信」的全部依据，
 * 它必须能被单元测试直接验证，而不是只能通过跑一遍完整 E2E 间接观察。
 * 之前它内联在 run-eval.mjs 里，要验证「要点分散在不同小节时会不会被误判为通过」
 * 得先起浏览器跑完整套 —— 成本高到没人会做。
 *
 * 判定口径（四道，任一条不满足即不通过）：
 *   ① 期望要点必须落在**同一条证据**内（每个 `.answer-part` 为一条）
 *   ② 不应出现的内容（rejectKeywords）在整块面板里都不得出现
 *   ③ 命中的那条证据必须是预期编号小节（expectUnitTitle）
 *   ④ 不得越界到兄弟小节（rejectUnitTitles）
 */

export const UNIT_MARK = ' · 完整小节';

/**
 * @param {object} testCase 用例定义（expectKeywords / expectUnitTitle / rejectKeywords / rejectUnitTitles / expectRefusal）
 * @param {{refused:boolean, answer:string, parts:string[]}} observed 实际观察结果
 * @returns {{pass:boolean, reason:string}}
 */
export function judge(testCase, observed) {
  const { refused, answer, parts } = observed;
  const evidence = Array.isArray(parts) ? parts : [];

  if (testCase.expectRefusal) {
    return { pass: refused, reason: refused ? '正确拒答' : '应拒答但给出了答案' };
  }
  if (refused) return { pass: false, reason: '未找到依据，但该问题有预期答案' };

  const keywords = testCase.expectKeywords || [];
  if (!evidence.length) return { pass: false, reason: '未取到任何证据块' };

  // ① 要点必须落在同一条证据内
  const hit = keywords.length
    ? evidence.find(part => keywords.every(keyword => part.includes(keyword)))
    : evidence[0];
  if (!hit) {
    const absent = keywords.filter(keyword => !evidence.some(part => part.includes(keyword)));
    if (absent.length) return { pass: false, reason: `缺少要点：${absent.join(' / ')}` };
    const spread = keywords
      .map(keyword => `「${keyword}」→第 ${evidence.findIndex(part => part.includes(keyword)) + 1} 条`)
      .join('、');
    return { pass: false, reason: `要点分散在不同证据中，未落在同一条：${spread}` };
  }

  // ② 不应出现的内容（按整块面板判定，比只看命中条更严）
  const leaked = (testCase.rejectKeywords || []).filter(keyword => answer.includes(keyword));
  if (leaked.length) return { pass: false, reason: `混入了不该出现的内容：${leaked.join(' / ')}` };

  // ③ 命中的那条证据必须是预期编号小节
  if (testCase.expectUnitTitle && !hit.includes(`${testCase.expectUnitTitle}${UNIT_MARK}`)) {
    return { pass: false, reason: `要点命中的证据不是预期小节「${testCase.expectUnitTitle}」` };
  }

  // ④ 不得越界到兄弟小节
  const crossed = (testCase.rejectUnitTitles || [])
    .filter(title => evidence.some(part => part.includes(`${title}${UNIT_MARK}`)));
  if (crossed.length) return { pass: false, reason: `越界到兄弟小节：${crossed.join(' / ')}` };

  return { pass: true, reason: '命中预期要点（同一条证据内）' };
}
