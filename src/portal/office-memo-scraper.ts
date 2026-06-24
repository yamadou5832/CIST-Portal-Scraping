import type { Page } from "playwright";

import type { PortalBrowserSession } from "./browser-session.js";
import { getCurrentPortalDate } from "./current-date.js";
import { formatDateTime, parsePortalDateTime, parsePortalMonthDay } from "./date-utils.js";
import type {
  FetchReceivedOfficeMemosOptions,
  OfficeMemoAttachment,
  OfficeMemoFilter,
  PaginatedReceivedOfficeMemos,
  ReceivedOfficeMemo,
  ReceivedOfficeMemoDetail,
} from "../types.js";
import { OFFICE_MEMO_PORTAL_PAGE_SIZE } from "../types.js";

interface RawReceivedOfficeMemo {
  title: string;
  officeMemoId: string;
  category: string;
  date: string;
  isBookmarked: boolean;
  isReviewNeeded: boolean;
  isUnread: boolean;
  isUpdated: boolean;
  isImportant: boolean;
}

interface RawReceivedOfficeMemosPage {
  items: RawReceivedOfficeMemo[];
  isLastPage: boolean;
}

export class OfficeMemoScraper {
  constructor(
    private readonly session: PortalBrowserSession,
    private readonly portalUrl: string,
  ) {}

  async fetchReceivedOfficeMemos(options: FetchReceivedOfficeMemosOptions = {}): Promise<PaginatedReceivedOfficeMemos> {
    const filter = options.filter ?? "all";
    const searchKeyword = options.searchKeyword ?? "";
    const categoryFilter = options.categoryFilter ?? "c_all";
    const pageOption = options.page;

    return this.session.withAuthenticatedPage(async (page) => {
      const referenceDate = await getCurrentPortalDate(page);
      const items: ReceivedOfficeMemo[] = [];
      const seenIds = new Set<string>();

      if (pageOption !== undefined) {
        const currentPage = Math.max(1, pageOption);
        const receivedTitlesUrl = this.buildReceivedOfficeMemosUrl(currentPage, filter, searchKeyword, categoryFilter);
        await page.goto(receivedTitlesUrl, { waitUntil: "domcontentloaded" });

        const { items: rawItems, isLastPage } = await this.extractReceivedOfficeMemosPage(page);

        for (const rawItem of rawItems) {
          if (seenIds.has(rawItem.officeMemoId)) {
            continue;
          }

          let date: Date;
          try {
            date = parsePortalMonthDay(rawItem.date, referenceDate);
          } catch {
            continue;
          }

          seenIds.add(rawItem.officeMemoId);
          items.push({
            title: rawItem.title,
            officeMemoId: rawItem.officeMemoId,
            category: rawItem.category,
            date,
            isBookmarked: rawItem.isBookmarked,
            isReviewNeeded: rawItem.isReviewNeeded,
            isUnread: rawItem.isUnread,
            isUpdated: rawItem.isUpdated,
            isImportant: rawItem.isImportant,
          });
        }

        return {
          items,
          pagination: {
            page: currentPage,
            limit: OFFICE_MEMO_PORTAL_PAGE_SIZE,
            hasNextPage: !isLastPage,
            hasPreviousPage: currentPage > 1,
          },
        };
      } else {
        let currentPage = 1;

        while (true) {
          const receivedTitlesUrl = this.buildReceivedOfficeMemosUrl(currentPage, filter, searchKeyword, categoryFilter);
          await page.goto(receivedTitlesUrl, { waitUntil: "domcontentloaded" });

          const { items: rawItems, isLastPage } = await this.extractReceivedOfficeMemosPage(page);

          for (const rawItem of rawItems) {
            if (seenIds.has(rawItem.officeMemoId)) {
              continue;
            }

            let date: Date;
            try {
              date = parsePortalMonthDay(rawItem.date, referenceDate);
            } catch {
              continue;
            }

            seenIds.add(rawItem.officeMemoId);
            items.push({
              title: rawItem.title,
              officeMemoId: rawItem.officeMemoId,
              category: rawItem.category,
              date,
              isBookmarked: rawItem.isBookmarked,
              isReviewNeeded: rawItem.isReviewNeeded,
              isUnread: rawItem.isUnread,
              isUpdated: rawItem.isUpdated,
              isImportant: rawItem.isImportant,
            });
          }

          if (isLastPage) {
            break;
          }

          currentPage += 1;
        }

        return {
          items,
          pagination: {
            page: 1,
            limit: items.length,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        };
      }
    });
  }

  async fetchReceivedOfficeMemoDetails(options: FetchReceivedOfficeMemosOptions = {}): Promise<ReceivedOfficeMemoDetail[]> {
    const { items } = await this.fetchReceivedOfficeMemos(options);
    return this.session.withAuthenticatedPage(async (page) => {
      const details: ReceivedOfficeMemoDetail[] = [];
      for (const item of items) {
        details.push(await this.fetchReceivedOfficeMemoDetailPage(page, item));
      }
      return details;
    });
  }

  async fetchReceivedOfficeMemoDetail(officeMemoId: string): Promise<ReceivedOfficeMemoDetail> {
    return this.session.withAuthenticatedPage((page) => this.fetchReceivedOfficeMemoDetailPage(page, { officeMemoId }));
  }

  private buildReceivedOfficeMemosUrl(
    currentPage: number,
    filter: OfficeMemoFilter,
    searchKeyword: string,
    categoryFilter: string,
  ): string {
    const url = new URL(`${this.portalUrl}/portal/OfficeMemo/ViewReceivedTitles`);
    url.searchParams.set("currentPage", String(Math.max(1, currentPage)));
    url.searchParams.set("filter", filter);
    url.searchParams.set("searchKeyword", searchKeyword);
    url.searchParams.set("c_filter", categoryFilter);
    return url.toString();
  }

  private buildReceivedOfficeMemoDetailUrl(officeMemoId: string): string {
    const url = new URL(`${this.portalUrl}/portal/OfficeMemo/ViewMemo`);
    url.searchParams.set("officememoid", officeMemoId);
    return url.toString();
  }

  private async fetchReceivedOfficeMemoDetailPage(
    page: Page,
    item: Pick<ReceivedOfficeMemo, "officeMemoId"> & Partial<ReceivedOfficeMemo>,
  ): Promise<ReceivedOfficeMemoDetail> {
    await page.goto(this.buildReceivedOfficeMemoDetailUrl(item.officeMemoId), { waitUntil: "domcontentloaded" });

    const parsed = await page.evaluate<{
      title: string;
      author: string;
      category: string;
      body: string;
      postedText: string;
      expiresText: string;
      attachments: OfficeMemoAttachment[];
      isBookmarked: boolean;
      isReviewNeeded: boolean;
      isUnread: boolean;
      isUpdated: boolean;
      isImportant: boolean;
    }>(String.raw`(() => {
      const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const normalizeBody = (value) =>
        (value ?? "")
          .replace(/\r/g, "")
          .split("\n")
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter((line) => line.length > 0)
          .join("\n");

      const card = document.querySelector(".main-contents .card.mb-3") ?? document.querySelector(".main-contents .card");
      const title = normalize(card?.querySelector(".card-header")?.textContent);

      const summaryBody = [...(card?.querySelectorAll(".card-body") ?? [])].find((element) =>
        element.classList.contains("border-bottom"),
      );
      const author =
        normalize(summaryBody?.querySelector(".bi-person, .bi-person-fill")?.parentElement?.textContent) ||
        normalize(summaryBody?.querySelector(".row .col-auto")?.textContent);
      const category =
        normalize(summaryBody?.querySelector(".bi-tag")?.parentElement?.textContent).replace(/^タグ\s*/, "") ||
        "---";

      const contentBody = [...(card?.querySelectorAll(".card-body") ?? [])].find(
        (element) => !element.classList.contains("border-bottom") && !element.classList.contains("border-top"),
      );
      const body = normalizeBody(contentBody?.innerText ?? contentBody?.textContent ?? "");

      const attachmentBody = [...(card?.querySelectorAll(".card-body.border-top") ?? [])].find((element) =>
        normalize(element.textContent).includes("添付ファイル"),
      );
      const attachments = [...(attachmentBody?.querySelectorAll("a.filename, a[href*='/OfficeMemo/OfficeMemo/download']") ?? [])]
        .map((element) => ({
          name: normalize(element.textContent),
          url: element.getAttribute("href") ?? "",
        }))
        .filter((attachment) => attachment.name && attachment.url);

      const postedBody = [...(card?.querySelectorAll(".card-body.border-top") ?? [])].find((element) =>
        normalize(element.textContent).includes("に掲示"),
      );
      const postedText = normalize(postedBody?.querySelector(".bi-clock")?.nextElementSibling?.textContent);
      const expiresText = normalize(postedBody?.querySelector(".bi-hourglass-bottom")?.nextElementSibling?.textContent);

      const badgeTexts = [...document.querySelectorAll(".badge")]
        .map((element) => normalize(element.textContent).replace(/\s+/g, ""))
        .filter((text) => text.length > 0);

      return {
        title,
        author,
        category,
        body,
        postedText,
        expiresText,
        attachments,
        isBookmarked: Boolean(card?.querySelector("i.bi-star-fill")),
        isReviewNeeded: badgeTexts.some((text) => text.includes("要確認")),
        isUnread: badgeTexts.some((text) => text.includes("未読")),
        isUpdated: badgeTexts.some((text) => text.includes("更新あり")),
        isImportant: normalize(summaryBody?.textContent).includes("重要"),
      };
    })()`);

    if (!parsed.title) {
      throw new Error(`officeMemoId not found: ${item.officeMemoId}`);
    }

    let postedAt: string | null = null;
    let expiresAt: string | null = null;
    let postedDate: Date | null = null;
    if (parsed.postedText) {
      try {
        postedDate = parsePortalDateTime(parsed.postedText);
        postedAt = formatDateTime(postedDate);
      } catch {
        postedDate = null;
        postedAt = null;
      }
    }
    if (parsed.expiresText) {
      try {
        expiresAt = formatDateTime(parsePortalDateTime(parsed.expiresText));
      } catch {
        expiresAt = null;
      }
    }

    return {
      title: item.title ?? parsed.title,
      officeMemoId: item.officeMemoId,
      category: item.category ?? parsed.category,
      date: item.date ?? postedDate ?? new Date(0),
      isBookmarked: item.isBookmarked ?? parsed.isBookmarked,
      isReviewNeeded: item.isReviewNeeded ?? parsed.isReviewNeeded,
      isUnread: item.isUnread ?? parsed.isUnread,
      isUpdated: item.isUpdated ?? parsed.isUpdated,
      isImportant: item.isImportant ?? parsed.isImportant,
      author: parsed.author,
      body: parsed.body,
      posted_at: postedAt,
      expires_at: expiresAt,
      attachments: parsed.attachments.map((attachment) => ({
        ...attachment,
        url: new URL(attachment.url, this.portalUrl).toString(),
      })),
    };
  }

  private async extractReceivedOfficeMemosPage(page: Page): Promise<RawReceivedOfficeMemosPage> {
    return page.evaluate<RawReceivedOfficeMemosPage>(() => {
      const cards = [...document.querySelectorAll("#commonViewReceivedTitles > div.card.mb-3.flex-row")];
      const items: RawReceivedOfficeMemo[] = [];

      for (const card of cards) {
        const titleLink = card.querySelector<HTMLAnchorElement>("h5.card-title a.no-underline");
        const title = titleLink?.textContent?.trim() ?? "";
        const href = titleLink?.getAttribute("href") ?? "";

        let officeMemoId = "";
        if (href) {
          try {
            officeMemoId = new URL(href, window.location.href).searchParams.get("officememoid") ?? "";
          } catch {
            officeMemoId = "";
          }
        }

        if (!officeMemoId) {
          officeMemoId = card.querySelector<HTMLInputElement>("input.bulk_operations")?.id?.trim() ?? "";
        }

        const date = card.querySelector<HTMLElement>("p.card-text span.ms-auto")?.textContent?.trim() ?? "";

        const categoryElement = card.querySelector<HTMLElement>("p.card-text .bi-tag")?.parentElement;
        const category = categoryElement?.querySelector<HTMLElement>("span")?.textContent?.trim() ?? "---";

        const badgeTexts = [...card.querySelectorAll<HTMLElement>(".position-absolute span.badge")]
          .map((element) => (element.textContent ?? "").replace(/\s+/g, ""))
          .filter((text) => text.length > 0);

        const isBookmarked = Boolean(card.querySelector("i.bi-star-fill"));
        const isReviewNeeded = badgeTexts.some((text) => text.includes("要確認"));
        const isUnread = badgeTexts.some((text) => text.includes("未読"));
        const isUpdated = badgeTexts.some((text) => text.includes("更新あり"));
        const isImportant = [...card.querySelectorAll("p.card-text span")].some((element) =>
          (element.textContent ?? "").replace(/\s+/g, "").includes("重要"),
        );

        if (!title || !officeMemoId || !date) {
          continue;
        }

        items.push({
          title,
          officeMemoId,
          category,
          date,
          isBookmarked,
          isReviewNeeded,
          isUnread,
          isUpdated,
          isImportant,
        });
      }

      const lastPageControl =
        document.querySelector<HTMLElement>("ul.pagination li:last-child .page-link") ??
        document.querySelector<HTMLElement>(".pagination .bi-chevron-double-right")?.closest(".page-link");
      const isLastPage = !lastPageControl || lastPageControl.classList.contains("disabled");

      return {
        items,
        isLastPage,
      };
    });
  }
}
