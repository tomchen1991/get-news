/** Fixed owner-approved relevance context; not a search plan or model instructions. */
export const EDITORIAL_PROFILE = {
  version: 1,
  coreInterests: [
    { topic: 'AI 模型与产品进展', keywords: ['主流模型发布', '能力实测', '价格与额度变化', '编程能力', '多模态能力'] },
    { topic: 'Agent 与 AI 开发实践', keywords: ['Agent 框架', 'MCP', '工具调用', '记忆与上下文', '评估', '开源实现', '部署经验', 'AI 编程工具', 'TypeScript / Node.js', '重要安全漏洞'] },
    { topic: '任天堂与核心游戏资讯', keywords: ['任天堂硬件', '第一方新作', '直面会', '发售日期', '可靠评测'] },
    { topic: '手机、数码与跨设备体验', keywords: ['OPPO / ColorOS', '手机 AI', 'Mac / iPad', '跨生态互联', '实际体验'] },
    { topic: '单机游戏新闻', keywords: ['PC / Xbox / PlayStation', 'XGP 入库退库', '新作发布与评测', '重大更新', '平台政策'] },
    { topic: '足球', keywords: ['武汉三镇', '中国足球', '中超', '英超', '欧冠', '赛程赛果', '转会', '俱乐部经营'] },
  ],
  secondaryInterests: [
    { topic: '智能汽车与特斯拉', keywords: ['2021 款 Model 3', 'OTA', '国内辅助驾驶实际落地', '现有车主权益', '纯电技术'] },
    { topic: '武汉本地实用资讯', keywords: ['交通变化', '公共服务', '亲子活动', '场馆开放', '预约与排队成本'] },
    { topic: '育儿、健康与力量训练', keywords: ['儿童健康与安全', '循证育儿', '力量训练', '运动恢复'] },
  ],
  relevantContext: ['开发者与 AI 重度用户，亲手搭建个人 Agent', 'OPPO X8 用户，手机之外主要使用苹果生态', '2021 款 Model 3 车主，偏好纯电，不考虑混动购买', '任天堂重度玩家，拥有 Xbox 和 XGP', '生活在武汉，有育儿和力量训练需求'],
  selectionPreferences: ['技术内容重具体机制、可复现证据和实际用途', '产品内容重实际体验，不按品牌阵营加分', '游戏与足球本身具有兴趣价值，无需证明生产力收益', '核心频道独立判断，不因技术背景而压低游戏、数码或足球价值', '健康内容重指南与可靠证据，区分单篇研究和已有共识；未提供儿童年龄，不推断适龄性'],
  downrank: ['空泛行业评论', '营销噱头与无实质更新的宣传', '品牌站队与跑分争论', '焦虑营销与伪科学', '缺乏证据的传闻'],
} as const;
