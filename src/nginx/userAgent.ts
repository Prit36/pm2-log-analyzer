export type AgentKind = "browser" | "bot" | "tool" | "unknown";

export type ParsedAgent = {
  kind: AgentKind;
  /** Browser, crawler, or client library name with major version. */
  name: string;
  os: string | null;
  mobile: boolean;
};

const bots: [RegExp, string][] = [
  [/googlebot/i, "Googlebot"],
  [/bingbot|bingpreview/i, "Bingbot"],
  [/yandex(bot|images)/i, "YandexBot"],
  [/baiduspider/i, "Baiduspider"],
  [/duckduckbot/i, "DuckDuckBot"],
  [/applebot/i, "Applebot"],
  [/facebookexternalhit|meta-externalagent/i, "Facebook"],
  [/twitterbot/i, "Twitterbot"],
  [/linkedinbot/i, "LinkedInBot"],
  [/slackbot/i, "Slackbot"],
  [/whatsapp/i, "WhatsApp"],
  [/telegrambot/i, "TelegramBot"],
  [/discordbot/i, "Discordbot"],
  [/ahrefsbot/i, "AhrefsBot"],
  [/semrushbot/i, "SemrushBot"],
  [/mj12bot/i, "MJ12bot"],
  [/dotbot/i, "DotBot"],
  [/petalbot/i, "PetalBot"],
  [/gptbot/i, "GPTBot"],
  [/claudebot|claude-web/i, "ClaudeBot"],
  [/ccbot/i, "CCBot"],
  [/bytespider/i, "Bytespider"],
  [/uptimerobot/i, "UptimeRobot"],
  [/pingdom/i, "Pingdom"],
  [/statuscake/i, "StatusCake"],
  [/elb-healthchecker/i, "ELB health check"],
  [/kube-probe/i, "kube-probe"],
  [/headlesschrome/i, "Headless Chrome"],
  [/bot\b|crawl|spider|slurp|scanner|monitor/i, "Other bot"],
];

const tools: [RegExp, string][] = [
  [/^curl\/(\d+)/i, "curl"],
  [/^wget\/(\d+)/i, "Wget"],
  [/python-requests\/(\d+)/i, "python-requests"],
  [/python-urllib|aiohttp|httpx/i, "Python"],
  [/go-http-client\/(\d+)/i, "Go http client"],
  [/okhttp\/(\d+)/i, "OkHttp"],
  [/axios\/(\d+)/i, "axios"],
  [/node-fetch|undici|^node\b/i, "Node.js"],
  [/postmanruntime\/(\d+)/i, "Postman"],
  [/insomnia\/(\d+)/i, "Insomnia"],
  [/apache-httpclient\/(\d+)/i, "Apache HttpClient"],
  [/^java\/(\d+)/i, "Java"],
  [/guzzlehttp/i, "Guzzle"],
  [/libwww-perl/i, "libwww-perl"],
  [/^dart\//i, "Dart"],
  [/cfnetwork/i, "CFNetwork"],
  [/^dalvik\//i, "Android app"],
];

const browsers: [RegExp, string][] = [
  [/edg(?:e|a|ios)?\/(\d+)/i, "Edge"],
  [/(?:opr|opera)\/(\d+)/i, "Opera"],
  [/samsungbrowser\/(\d+)/i, "Samsung Internet"],
  [/yabrowser\/(\d+)/i, "Yandex Browser"],
  [/(?:firefox|fxios)\/(\d+)/i, "Firefox"],
  [/(?:chrome|crios)\/(\d+)/i, "Chrome"],
  [/version\/(\d+)[.\d]* (?:mobile\/\S+ )?safari/i, "Safari"],
  [/msie (\d+)|trident\/.*rv:(\d+)/i, "Internet Explorer"],
];

function detectOs(agent: string): string | null {
  if (/windows nt 10/i.test(agent)) return "Windows";
  if (/windows/i.test(agent)) return "Windows (legacy)";
  if (/android/i.test(agent)) return "Android";
  if (/iphone|ipad|ipod/i.test(agent)) return "iOS";
  if (/mac os x|macintosh/i.test(agent)) return "macOS";
  if (/cros/i.test(agent)) return "ChromeOS";
  if (/linux/i.test(agent)) return "Linux";
  return null;
}

function withVersion(name: string, match: RegExpMatchArray | null): string {
  const version = match?.slice(1).find((part) => part !== undefined);
  return version ? `${name} ${version}` : name;
}

const cache = new Map<string, ParsedAgent>();

export function parseUserAgent(agent: string): ParsedAgent {
  const cached = cache.get(agent);
  if (cached) return cached;
  let parsed: ParsedAgent = {
    kind: "unknown",
    name: agent && agent !== "-" ? "Unknown" : "Not logged",
    os: null,
    mobile: false,
  };
  if (agent && agent !== "-") {
    const os = detectOs(agent);
    const mobile = /mobile|iphone|android.*mobile/i.test(agent);
    const bot = bots.find(([pattern]) => pattern.test(agent));
    const tool = bot ? undefined : tools.find(([pattern]) => pattern.test(agent));
    if (bot) parsed = { kind: "bot", name: bot[1], os: null, mobile: false };
    else if (tool)
      parsed = { kind: "tool", name: withVersion(tool[1], agent.match(tool[0])), os, mobile };
    else {
      for (const [pattern, name] of browsers) {
        const match = agent.match(pattern);
        if (match) {
          parsed = { kind: "browser", name: withVersion(name, match), os, mobile };
          break;
        }
      }
      if (parsed.kind === "unknown") parsed = { ...parsed, os, mobile };
    }
  }
  cache.set(agent, parsed);
  return parsed;
}

export const agentKindLabel = {
  browser: "Browser",
  bot: "Bot",
  tool: "Script / tool",
  unknown: "Unknown",
} satisfies Record<AgentKind, string>;
