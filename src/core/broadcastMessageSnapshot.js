const MAX_TEXTS = 16;
const MAX_IMAGES = 8;
const MAX_ACTIONS = 12;

function clean(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function safeHttpUrl(value) {
  const raw = clean(value, 2000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : '';
  } catch (_err) {
    return '';
  }
}

function pushUnique(list, value, limit) {
  const normalized = clean(value);
  if (!normalized || list.includes(normalized) || list.length >= limit) return;
  list.push(normalized);
}

function actionLabel(action, node) {
  if (action && action.label) return clean(action.label, 200);
  const contents = node && Array.isArray(node.contents) ? node.contents : [];
  const textChild = contents.find((child) => child && child.type === 'text' && child.text);
  return textChild ? clean(textChild.text, 200) : '';
}

function inspectFlexNode(node, result) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => inspectFlexNode(child, result));
    return;
  }

  if (node.type === 'text') pushUnique(result.texts, node.text, MAX_TEXTS);

  if (node.type === 'image') {
    const url = safeHttpUrl(node.url);
    if (url && result.images.length < MAX_IMAGES && !result.images.includes(url)) {
      result.images.push(url);
    }
  }

  const action = node.action && typeof node.action === 'object' ? node.action : null;
  if (action && result.actions.length < MAX_ACTIONS) {
    if (action.type === 'uri') {
      const url = safeHttpUrl(action.uri);
      const label = actionLabel(action, node) || '開啟連結';
      if (url && !result.actions.some((item) => item.type === 'uri' && item.url === url && item.label === label)) {
        result.actions.push({ type: 'uri', label, url });
      }
    } else if (action.type === 'message' || action.type === 'postback') {
      const label = actionLabel(action, node) || clean(action.text || action.data, 200) || '互動按鈕';
      if (!result.actions.some((item) => item.type === action.type && item.label === label)) {
        result.actions.push({ type: action.type, label, value: clean(action.text || action.data, 500) });
      }
    }
  }

  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (value && typeof value === 'object') inspectFlexNode(value, result);
  });
}

function templateSummary(config, options) {
  const template = config && config.template && typeof config.template === 'object'
    ? config.template
    : {};
  const origin = clean(options.origin, 1000).replace(/\/+$/, '');
  const heroMediaId = clean(template.heroMediaId, 100);
  const heroUrl = origin && heroMediaId ? `${origin}/p/line-media/${heroMediaId}` : '';
  const ctaUrl = safeHttpUrl(template.ctaUrl);
  return {
    mode: 'template',
    modeLabel: options.channel === 'email' ? 'Email 卡片' : '一般卡片',
    notificationText: clean(template.altText || template.title, 400),
    title: clean(template.title, 500),
    texts: [clean(template.subtitle), clean(template.disclaimer)].filter(Boolean),
    couponCode: clean(template.couponCode, 200),
    images: heroUrl ? [heroUrl] : [],
    actions: template.ctaLabel || ctaUrl
      ? [{ type: 'uri', label: clean(template.ctaLabel, 200) || 'CTA', url: ctaUrl, invalidUrl: !ctaUrl }]
      : [],
    segments: []
  };
}

function flexSummary(config) {
  const flex = config && config.flex && typeof config.flex === 'object' ? config.flex : {};
  const summary = {
    mode: 'flex_json',
    modeLabel: '自訂 Flex 卡片',
    notificationText: clean(flex.altText, 400),
    title: '',
    texts: [],
    couponCode: '',
    images: [],
    actions: [],
    segments: []
  };
  inspectFlexNode(flex.contents, summary);
  summary.title = summary.texts.shift() || '';
  return summary;
}

function summarizeConfig(config, options = {}, depth = 0) {
  const safe = config && typeof config === 'object' ? config : {};
  if (safe.mode === 'sequence' && depth < 2) {
    const items = Array.isArray(safe.items) ? safe.items : [];
    const segments = items.slice(0, 5).map((item, index) => {
      const value = item && typeof item === 'object' ? item : {};
      if (value.type === 'text') {
        return {
          index: index + 1,
          typeLabel: '文字',
          summary: {
            mode: 'text', modeLabel: '文字', notificationText: '', title: '',
            texts: [clean(value.text)].filter(Boolean), couponCode: '', images: [], actions: [], segments: []
          }
        };
      }
      if (value.type === 'image' || value.type === 'video') {
        const preview = safeHttpUrl(value.previewImageUrl || value.originalContentUrl);
        const original = safeHttpUrl(value.originalContentUrl);
        return {
          index: index + 1,
          typeLabel: value.type === 'video' ? '影片' : '圖片',
          summary: {
            mode: value.type, modeLabel: value.type === 'video' ? '影片' : '圖片', notificationText: '', title: '', texts: [],
            couponCode: '', images: preview ? [preview] : [],
            actions: original ? [{ type: 'media', label: value.type === 'video' ? '影片網址' : '原圖網址', url: original }] : [],
            segments: []
          }
        };
      }
      if (value.type === 'card') {
        return {
          index: index + 1,
          typeLabel: '卡片',
          summary: summarizeConfig(value.message_config, options, depth + 1)
        };
      }
      return {
        index: index + 1,
        typeLabel: '未知內容',
        summary: { mode: 'unknown', modeLabel: '未知內容', notificationText: '', title: '', texts: [], couponCode: '', images: [], actions: [], segments: [] }
      };
    });
    const firstTextSegment = segments.find((segment) => segment.summary.texts && segment.summary.texts[0]);
    return {
      mode: 'sequence',
      modeLabel: `多段訊息（${segments.length} 段）`,
      notificationText: '',
      title: firstTextSegment ? clean(firstTextSegment.summary.texts[0], 200) : '',
      texts: [], couponCode: '', images: [], actions: [], segments
    };
  }
  if (safe.mode === 'flex_json') return flexSummary(safe);
  return templateSummary(safe, options);
}

function buildBroadcastMessageSnapshots(broadcast, options = {}) {
  const source = broadcast && typeof broadcast === 'object' ? broadcast : {};
  const channel = source.channel === 'email' ? 'email' : 'line';
  const experiment = source.audience_config && source.audience_config.experiment;
  const variants = [{ key: 'a', label: source.is_ab_test || experiment ? '版本 A' : '實際發送內容', config: source.message_config }];
  if (source.is_ab_test || experiment) {
    variants.push({ key: 'b', label: '版本 B', config: source.variant_b_message_config });
  }
  if (experiment && Number(experiment.variantCount) === 3) {
    variants.push({ key: 'c', label: '版本 C', config: experiment.variantCMessageConfig });
  }

  const sourceMeta = source.audience_config && source.audience_config.messageSource;
  return {
    channel,
    channelLabel: channel === 'email' ? 'Email 信件' : 'LINE 推播',
    subject: channel === 'email' ? clean(source.email_subject, 300) : '',
    fromName: channel === 'email' ? clean(source.email_from_name, 200) : '',
    fromAddress: channel === 'email' ? clean(source.email_from_address, 300) : '',
    sourceName: sourceMeta && clean(sourceMeta.name, 200),
    sourceId: sourceMeta && Number.isInteger(Number(sourceMeta.id)) ? Number(sourceMeta.id) : null,
    variants: variants.map((variant) => ({
      key: variant.key,
      label: variant.label,
      config: variant.config && typeof variant.config === 'object' ? variant.config : {},
      summary: summarizeConfig(variant.config, { ...options, channel })
    }))
  };
}

function getBroadcastMessageIdentity(broadcast, options = {}) {
  const snapshots = buildBroadcastMessageSnapshots(broadcast, options);
  const primary = snapshots.variants[0] && snapshots.variants[0].summary
    ? snapshots.variants[0].summary
    : {};
  const candidates = [
    snapshots.sourceName,
    snapshots.subject,
    primary.notificationText,
    primary.title,
    primary.texts && primary.texts[0]
  ].map((value) => clean(value, 200)).filter(Boolean);
  const title = candidates[0] || '（沒有可辨識文字）';
  const preview = candidates.find((value) => value !== title) || '';
  return {
    title,
    preview,
    channelLabel: snapshots.channelLabel,
    variantCount: snapshots.variants.length
  };
}

module.exports = {
  buildBroadcastMessageSnapshots,
  getBroadcastMessageIdentity,
  summarizeConfig,
  safeHttpUrl
};
