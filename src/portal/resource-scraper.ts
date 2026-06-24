import type { PortalBrowserSession } from "./browser-session.js";
import { formatDateTime, parsePortalDateTime } from "./date-utils.js";
import type { DistributionPdfGroup, UndoneQuestionnaire } from "../types.js";

export class ResourceScraper {
  constructor(
    private readonly session: PortalBrowserSession,
    private readonly portalUrl: string,
  ) {}

  async fetchDistributionPdfUrls(): Promise<DistributionPdfGroup[]> {
    return this.session.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.portalUrl}/portal/Distribution/DistributionDownloaderPage`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("a.filename").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
      return page.evaluate<DistributionPdfGroup[]>(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const pdfItems = [...document.querySelectorAll("a.filename[href]")]
          .map((element) => ({
            title: normalize(element.textContent),
            url: element.getAttribute("href") ?? "",
            element,
          }))
          .filter((item) => {
            if (!item.title || !item.url) {
              return false;
            }
            try {
              const parsed = new URL(item.url, window.location.href);
              const filepath = parsed.searchParams.get("filepath") ?? "";
              if (filepath.toLowerCase().endsWith(".pdf")) {
                return true;
              }
              return parsed.pathname.toLowerCase().endsWith(".pdf");
            } catch {
              return false;
            }
          });

        const groups = new Map();
        for (const item of pdfItems) {
          let genre = "";
          let node = item.element.parentElement;
          while (node && !genre) {
            const heading = node.querySelector("h1, h2, h3, h4, h5, .card-header, .accordion-button");
            genre = normalize(heading?.textContent);
            node = node.parentElement;
          }
          if (!genre) {
            let prev = item.element.previousElementSibling;
            while (prev && !genre) {
              if (["H1", "H2", "H3", "H4", "H5"].includes(prev.tagName)) {
                genre = normalize(prev.textContent);
                break;
              }
              prev = prev.previousElementSibling;
            }
          }
          const key = genre || "その他";
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key).push({
            title: item.title,
            url: item.url,
          });
        }

        return [...groups.entries()].map(([genre, items]) => ({
          genre,
          items,
        }));
      })()`).then((items) =>
        items.map((group) => ({
          genre: group.genre,
          items: group.items.map((item) => ({
            ...item,
            url: new URL(item.url, this.portalUrl).toString(),
          })),
        })),
      );
    });
  }

  async fetchUndoneQuestionnaires(): Promise<UndoneQuestionnaire[]> {
    return this.session.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.portalUrl}/portal/Questionnaire/QuestionnairesForYouList?answerStatusFilter=undone`, {
        waitUntil: "domcontentloaded",
      });

      const rawItems = await page.evaluate<
        Array<{
          questionnaireId: string;
          title: string;
          deadlineText: string;
          isClosed: boolean;
          isAnonymous: boolean;
          isRepeatable: boolean;
          category: string;
        }>
      >(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const cards = [...document.querySelectorAll(".main-contents .card.mb-3")];
        const items = [];

        for (const card of cards) {
          const form = card.querySelector("form");
          const questionnaireId = normalize(form?.querySelector("input[name='questionnaireId']")?.getAttribute("value"));
          const title =
            normalize(card.querySelector(".card-title h5")?.textContent) ||
            normalize(card.querySelector(".card-title")?.textContent);
          if (!questionnaireId || !title) {
            continue;
          }

          const text = normalize(card.textContent);
          const deadlineText = (text.match(/期限：\s*([0-9]{4}\/[0-9]{2}\/[0-9]{2}[^0-9]*[0-9]{2}:[0-9]{2})/) ?? [])[1] ?? "";
          const isClosed = card.querySelector(".card-body")?.classList.contains("bg-secondary-subtle") ?? false;
          const isAnonymous = text.includes("匿名回答");
          const isRepeatable = text.includes("回答のやり直し可");

          let category = "";
          if (text.includes("授業評価")) {
            category = "授業評価";
          } else if (text.includes("自己分析")) {
            category = "自己分析";
          } else if (text.includes("その他")) {
            category = "その他";
          }

          items.push({
            questionnaireId,
            title,
            deadlineText,
            isClosed,
            isAnonymous,
            isRepeatable,
            category,
          });
        }

        return items;
      })()`);

      return rawItems.map((item) => {
        let deadlineAt: string | null = null;
        if (item.deadlineText) {
          try {
            deadlineAt = formatDateTime(parsePortalDateTime(item.deadlineText));
          } catch {
            deadlineAt = null;
          }
        }

        return {
          questionnaireId: item.questionnaireId,
          title: item.title,
          deadline_at: deadlineAt,
          is_closed: item.isClosed,
          is_anonymous: item.isAnonymous,
          is_repeatable: item.isRepeatable,
          category: item.category,
        };
      });
    });
  }
}
