import os
import pickle
import logging
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv
from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from url_normalize import url_normalize


logger = logging.getLogger(__name__)


@dataclass
class Config:
    portal_url: str
    username: str
    password: str
    cookie_path: str


class PortalClient:
    MEMO_FILTERS = {
        "all": "all",
        "unread": "unread",
        "read": "read",
        "star": "star",
    }

    def __init__(self, config: Config) -> None:
        self.config = config
        self.driver: webdriver.Chrome | None = None
        self.implicit_wait_seconds = int(os.getenv("SELENIUM_IMPLICIT_WAIT", "5"))
        logger.debug("PortalClientを初期化しました")

    @contextmanager
    def _temporary_implicit_wait(self, seconds: int):
        if self.driver is None:
            yield
            return

        self.driver.implicitly_wait(seconds)
        try:
            yield
        finally:
            self.driver.implicitly_wait(self.implicit_wait_seconds)

    @classmethod
    def from_env(cls) -> "PortalClient":
        logger.debug("環境変数の読み込みを開始します")
        load_dotenv()
        portal_url = os.getenv("CIST_PORTAL_URL") or "https://portal.mc.chitose.ac.jp"
        username = os.getenv("CIST_USERNAME")
        password = os.getenv("CIST_PASSWORD")
        cookie_path = os.getenv("COOKIE_PATH") or "./cookie.pkl"

        if not username or not password:
            raise ValueError(
                "USERNAME and PASSWORD must be set in the environment variables"
            )

        config = Config(
            portal_url=portal_url,
            username=username,
            password=password,
            cookie_path=cookie_path,
        )
        logger.debug("環境変数の読み込みが完了しました")
        return cls(config)

    @property
    def target_url(self) -> str:
        return f"{self.config.portal_url}/portal/MyPage"

    @property
    def login_url(self) -> str:
        return f"{self.config.portal_url}/portal"

    @property
    def officememo_url(self) -> str:
        return f"{self.config.portal_url}/portal/OfficeMemo/ViewReceivedTitles"

    def build_officememo_url(
        self,
        filter_type: Literal["all", "unread", "read", "star"] = "all",
        current_page: int = 1,
    ) -> str:
        if filter_type not in self.MEMO_FILTERS:
            raise ValueError("filter_type must be one of: all, unread, read, star")
        if current_page < 1:
            raise ValueError("current_page must be >= 1")

        return (
            f"{self.officememo_url}?currentPage={current_page}"
            f"&filter={self.MEMO_FILTERS[filter_type]}"
        )

    @staticmethod
    def _normalize_url(url: str) -> str:
        return url_normalize(url) or ""

    def _normalize_url_for_check(self, url: str) -> str:
        normalized_url = self._normalize_url(url)
        parsed = urlsplit(normalized_url)
        path = parsed.path.removesuffix("/")
        return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))

    @staticmethod
    def _parse_portal_datetime(text: str, year: int | None = None) -> datetime:
        cleaned = re.sub(r"[（(][^)）]*[）)]", "", text).strip()
        cleaned = re.sub(r"\s+", " ", cleaned)

        if re.fullmatch(r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}", cleaned):
            return datetime.strptime(cleaned, "%Y/%m/%d %H:%M")

        if re.fullmatch(r"\d{2}/\d{2} \d{2}:\d{2}", cleaned):
            base_year = year or datetime.now().year
            return datetime.strptime(f"{base_year}/{cleaned}", "%Y/%m/%d %H:%M")

        raise ValueError(f"日時の解析に失敗しました: {text}")

    def _get_current_portal_date(self) -> datetime:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        date_text = self.driver.execute_script(
            """
            const dateEl = document.querySelector("header .bi-clock-fill + span");
            return dateEl ? dateEl.textContent.trim() : "";
            """
        )
        match = re.search(r"(\d{4}/\d{2}/\d{2})", date_text or "")
        if not match:
            raise ValueError("ヘッダーの日付を取得できませんでした")

        return datetime.strptime(match.group(1), "%Y/%m/%d")

    def start(self) -> None:
        logger.debug("WebDriverの起動を開始します")
        self.driver = webdriver.Chrome()
        self.driver.implicitly_wait(self.implicit_wait_seconds)
        logger.debug("暗黙待機時間を%s秒に設定しました", self.implicit_wait_seconds)
        self.driver.get(self.config.portal_url)
        logger.debug("初期URLへアクセスしました: %s", self.config.portal_url)
        self._load_cookies()
        logger.debug("WebDriverの起動処理が完了しました")

    def _load_cookies(self) -> None:
        if self.driver is None:
            logger.debug("Driver未起動のためCookie読み込みをスキップします")
            return

        logger.debug("Cookieの読み込みを開始します: %s", self.config.cookie_path)
        if os.path.exists(self.config.cookie_path):
            with open(self.config.cookie_path, "rb") as f:
                cookies = pickle.load(f)
                for cookie in cookies:
                    self.driver.add_cookie(cookie)
            self.driver.refresh()
            logger.debug("Cookieを%d件読み込み、ページを更新しました", len(cookies))
            return

        logger.debug("Cookieファイルが見つからないため、読み込みをスキップします")

    def _save_cookies(self) -> None:
        if self.driver is None:
            logger.debug("Driver未起動のためCookie保存をスキップします")
            return

        cookies = self.driver.get_cookies()
        with open(self.config.cookie_path, "wb") as f:
            pickle.dump(cookies, f)
        logger.debug(
            "Cookieを%d件保存しました: %s", len(cookies), self.config.cookie_path
        )

    def login(self) -> bool:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug("ログイン判定のためMyPageへアクセスします")
        self.driver.get(self.target_url)
        time.sleep(2)

        current_url = self._normalize_url_for_check(self.driver.current_url)
        logger.debug("現在のURL: %s", current_url)

        if current_url == self._normalize_url_for_check(self.target_url):
            logger.debug("すでにログイン済みです")
            return True

        if current_url == self._normalize_url_for_check(self.login_url):
            logger.debug("ログインページに遷移したため、認証情報を入力します")
            elem_name = self.driver.find_element(By.ID, "username")
            elem_name.clear()
            elem_name.send_keys(self.config.username)
            elem_pass = self.driver.find_element(By.ID, "password")
            elem_pass.clear()
            elem_pass.send_keys(self.config.password)
            elem_login = self.driver.find_element(By.ID, "login")
            ActionChains(driver=self.driver).move_to_element(elem_login).perform()
            elem_login.click()

            time.sleep(2)

            current_url = self._normalize_url_for_check(self.driver.current_url)
            logger.debug("ログイン操作後のURL: %s", current_url)
            if current_url == self._normalize_url_for_check(self.target_url):
                logger.debug("ログインに成功しました")
                return True

        logger.debug("ログインに失敗しました")
        return False

    def check_login_status(self) -> bool:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug("ログイン状態確認のためMyPageへアクセスします")
        self.driver.get(self.target_url)

        time.sleep(2)

        current_url = self._normalize_url_for_check(self.driver.current_url)
        logger.debug("現在のURL: %s", current_url)

        normalized_target_url = self._normalize_url_for_check(self.target_url)
        normalized_login_url = self._normalize_url_for_check(self.login_url)

        if current_url == normalized_target_url:
            logger.debug("判定結果: ログイン済みです")
            return True
        if current_url.startswith(normalized_login_url):
            logger.debug("判定結果: 未ログインです（ログインページに遷移）")
            return False

        logger.debug("判定結果: 予期しないページに遷移しました")
        return False

    def get_notification_counts(self):
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug("通知件数の取得を開始します")
        self.driver.get(self.target_url)
        counts = {
            "memo": 0,  # 連絡（未読）
            "schedule": 0,  # 予定（未承諾）
            "questionnaire": 0,  # アンケート（未回答）
        }

        try:
            # 1. 連絡（未読件数）の取得
            # href属性に 'OfficeMemo' を含む <a> タグの中の <span class="fs-5"> を探す
            memo_element = self.driver.find_element(
                By.CSS_SELECTOR, "a[href*='OfficeMemo'] span.fs-5"
            )
            counts["memo"] = int(memo_element.text)

            # 2. 予定（未承諾件数）の取得
            # href属性に 'Schedule' を含む
            schedule_element = self.driver.find_element(
                By.CSS_SELECTOR, "a[href*='Schedule'] span.fs-5"
            )
            counts["schedule"] = int(schedule_element.text)

            # 3. アンケート（未回答件数）の取得
            # href属性に 'Questionnaire' を含む
            questionnaire_element = self.driver.find_element(
                By.CSS_SELECTOR, "a[href*='Questionnaire'] span.fs-5"
            )
            counts["questionnaire"] = int(questionnaire_element.text)
            logger.debug("通知件数を取得しました: %s", counts)

        except NoSuchElementException as e:
            logger.exception("要素が見つかりませんでした: %s", e)
        except ValueError:
            logger.exception("件数のテキストを数値に変換できませんでした")

        return counts

    def get_unsubmitted_reports(self) -> list[dict]:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug("未提出レポート一覧の取得を開始します")
        self.driver.get(self.target_url)

        raw_reports = self.driver.execute_script(
            """
            const sections = [...document.querySelectorAll("section")];
            const section = sections.find((s) =>
              (s.querySelector("h4")?.textContent || "").includes("未提出レポート一覧")
            );
            if (!section) return [];

            const rows = [...section.querySelectorAll("table tbody tr")];
            return rows.map((row) => {
              const tds = row.querySelectorAll("td");
              const link = tds[1]?.querySelector("a");
              const href = link?.getAttribute("href") || "";

              let form = row.querySelector("form");
              let formName = "";
              if (href.startsWith("javascript:") && href.endsWith(".submit()")) {
                formName = href.slice("javascript:".length, -".submit()".length).trim();
              }

              if ((!form || !form.querySelector("input[name='courseId']")) && formName) {
                form = document.forms[formName] || document.querySelector(`form[name="${formName}"]`);
              }

              const courseId =
                row.querySelector("input[name='courseId']")?.value ||
                form?.querySelector("input[name='courseId']")?.value ||
                form?.elements?.courseId?.value ||
                "";

              const lectureId =
                row.querySelector("input[name='lectureId']")?.value ||
                form?.querySelector("input[name='lectureId']")?.value ||
                form?.elements?.lectureId?.value ||
                "";

              return {
                course_name: tds[0]?.textContent?.trim() || "",
                report_name: tds[1]?.querySelector("a")?.textContent?.trim() || "",
                start_at: tds[2]?.textContent?.trim() || "",
                end_at: tds[3]?.textContent?.trim() || "",
                courseId,
                lectureId,
              };
            });
            """
        )

        reports = []
        for raw in raw_reports:
            if not raw["courseId"] or not raw["lectureId"]:
                continue
            reports.append(
                {
                    "course_name": raw["course_name"],
                    "courseId": raw["courseId"],
                    "report_name": raw["report_name"],
                    "lectureId": raw["lectureId"],
                    "start_at": self._parse_portal_datetime(raw["start_at"]),
                    "end_at": self._parse_portal_datetime(raw["end_at"]),
                }
            )

        logger.debug("未提出レポートを%d件取得しました", len(reports))
        return reports

    def get_new_reflection_replies(self) -> list[dict]:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug("新着の振り返り返信の取得を開始します")
        self.driver.get(self.target_url)

        raw_replies = self.driver.execute_script(
            """
            const sections = [...document.querySelectorAll("section")];
            const section = sections.find((s) =>
              (s.querySelector("h4")?.textContent || "").includes("新着の振り返り返信")
            );
            if (!section) return [];

            const headers = [...section.querySelectorAll("h3.fs-5")];
            return headers.map((h3) => {
              const text = h3.textContent.trim();
              const splitIndex = text.indexOf(" - ");
              const dateText = splitIndex >= 0 ? text.slice(0, splitIndex).trim() : "";
              const courseName = splitIndex >= 0 ? text.slice(splitIndex + 3).trim() : "";

              const wrapper = h3.nextElementSibling;
              const form = wrapper?.querySelector("form");
              return {
                date: dateText,
                course_name: courseName,
                report_name: form?.querySelector("a span")?.textContent?.trim() || "",
                courseId: form?.querySelector("input[name='courseId']")?.value || "",
                lectureId: form?.querySelector("input[name='lectureId']")?.value || "",
              };
            });
            """
        )

        replies = []
        for raw in raw_replies:
            if not raw["date"] or not raw["courseId"] or not raw["lectureId"]:
                continue

            replies.append(
                {
                    "date": datetime.strptime(raw["date"], "%Y-%m-%d"),
                    "course_name": raw["course_name"],
                    "courseId": raw["courseId"],
                    "report_name": raw["report_name"],
                    "lectureId": raw["lectureId"],
                }
            )

        logger.debug("新着の振り返り返信を%d件取得しました", len(replies))
        return replies

    def get_weekly_timetable(self) -> list[dict]:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug("今週の時間割の取得を開始します")
        self.driver.get(self.target_url)

        today = self._get_current_portal_date().date()
        sunday = today - timedelta(days=(today.weekday() + 1) % 7)

        raw_items = self.driver.execute_script(
            """
            const sections = [...document.querySelectorAll("section")];
            const section = sections.find((s) =>
              (s.querySelector("h4")?.textContent || "").includes("今週の時間割")
            );
            if (!section) return [];

            const rows = [...section.querySelectorAll("table.timetable tbody tr")];
            const results = [];

            for (const row of rows) {
              const cells = row.querySelectorAll("td");
              if (!cells.length) continue;

              const period = Number(cells[0].textContent.trim());
              if (!Number.isInteger(period)) continue;

              for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
                const dayCell = cells[dayIndex + 1];
                if (!dayCell) continue;

                const cards = [...dayCell.querySelectorAll("div.card-text")];
                for (const card of cards) {
                  const form = card.querySelector("form");
                  const courseName = form?.querySelector("button")?.textContent?.trim() || "";
                  const courseId = form?.querySelector("input[name='courseId']")?.value || "";
                  const roomRaw = card.querySelector("span")?.textContent?.trim() || "";
                  let classroom = roomRaw;
                  if (classroom.startsWith("[")) classroom = classroom.slice(1);
                  if (classroom.endsWith("]")) classroom = classroom.slice(0, -1);

                  if (!courseName || !courseId) continue;

                  results.push({
                    day_index: dayIndex,
                    period,
                    classroom,
                    course_name: courseName,
                    courseId,
                  });
                }
              }
            }

            return results;
            """
        )

        timetable = []
        for raw in raw_items:
            lesson_date = sunday + timedelta(days=raw["day_index"])
            timetable.append(
                {
                    "classroom": raw["classroom"],
                    "course_name": raw["course_name"],
                    "courseId": raw["courseId"],
                    "date": lesson_date.isoformat(),
                    "period": raw["period"],
                }
            )

        logger.debug("今週の時間割を%d件取得しました", len(timetable))
        return timetable

    def get_messages(
        self,
        filter_type: Literal["all", "unread", "read", "star"] = "all",
        current_page: int = 1,
    ) -> list[dict]:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        logger.debug(
            "メッセージ一覧の取得を開始します: filter=%s, page=%d",
            filter_type,
            current_page,
        )
        target_url = self.build_officememo_url(
            filter_type=filter_type,
            current_page=current_page,
        )
        self.driver.get(target_url)
        messages = []

        # メッセージのカード要素をすべて取得
        cards = self.driver.find_elements(
            By.CSS_SELECTOR, "#commonViewReceivedTitles .card.flex-row"
        )
        logger.debug("メッセージカードを%d件検出しました", len(cards))

        for card in cards:
            message_id = "不明"
            try:
                # 1. タイトルとリンクURL
                title_element = card.find_element(By.CSS_SELECTOR, "a.no-underline")
                title = title_element.text.strip()
                link_url = title_element.get_attribute("href")

                # 2. メッセージID（チェックボックスのID属性から取得）
                checkbox = card.find_element(By.CSS_SELECTOR, "input.bulk_operations")
                message_id = checkbox.get_attribute("id")

                card_text = card.text

                # 3. 未読ステータス（要素が存在すれば未読）
                is_unread = "未読" in card_text

                # 4. 重要フラグ（要素が存在すれば重要）
                is_important = "重要" in card_text

                # 5. 更新ありフラグ
                is_updated = "更新あり" in card_text

                is_review_needed = "要確認" in card_text

                # 6. カテゴリ（タグアイコンの隣にあるspanテキスト）
                with self._temporary_implicit_wait(0):
                    category_elements = card.find_elements(
                        By.XPATH,
                        ".//i[contains(@class, 'bi-tag')]/following-sibling::span",
                    )
                category = category_elements[0].text if category_elements else "なし"

                # 7. 日付（一番右下に配置されているテキスト）
                date_text = card.find_element(By.CSS_SELECTOR, "span.ms-auto").text

                # 抽出したデータを辞書としてリストに追加
                messages.append(
                    {
                        "id": message_id,
                        "title": title,
                        "url": link_url,
                        "category": category,
                        "date": date_text,
                        "is_unread": is_unread,
                        "is_important": is_important,
                        "is_updated": is_updated,
                        "is_review_needed": is_review_needed,
                    }
                )
                logger.debug(
                    "メッセージを抽出しました: id=%s, title=%s", message_id, title
                )

            except Exception as e:
                logger.exception(
                    "メッセージの抽出中にエラーが発生しました (ID: %s): %s",
                    message_id,
                    e,
                )
                continue

        logger.debug("メッセージ一覧の取得が完了しました: %d件", len(messages))
        return messages

    def close(self) -> None:
        if self.driver is None:
            logger.debug("Driver未起動のため終了処理をスキップします")
            return

        logger.debug("終了処理を開始します")
        self._save_cookies()
        self.driver.quit()
        self.driver = None
        logger.debug("終了処理が完了しました")

    def run(self) -> None:
        logger.debug("run処理を開始します")
        self.start()
        try:
            if not self.login():
                logger.error("ログインに失敗しました")
                raise Exception("ログインに失敗しました")

            if not self.check_login_status():
                logger.error("ログインに失敗しました")
                raise Exception("ログインに失敗しました")

            counts = self.get_notification_counts()
            logger.info(
                "連絡: %s件, 予定: %s件, アンケート: %s件",
                counts["memo"],
                counts["schedule"],
                counts["questionnaire"],
            )

            # messages = self.get_messages(filter_type="all")
            # logger.info("取得したメッセージを出力します: %d件", len(messages))
            # for msg in messages:
            #     logger.info(
            #         "タイトル: %s, 日付: %s, 未読: %s, 重要: %s, 更新あり: %s, 要確認: %s",
            #         msg["title"],
            #         msg["date"],
            #         msg["is_unread"],
            #         msg["is_important"],
            #         msg["is_updated"],
            #         msg["is_review_needed"],
            #     )

            timetables = self.get_weekly_timetable()
            logger.info("取得した時間割を出力します: %s件", len(timetables))
            for timetable in timetables:
                logger.info(
                    "教室: %s, 授業名: %s, 授業Id: %s, 日付: %s, 時間: %s",
                    timetable["classroom"],
                    timetable["course_name"],
                    timetable["courseId"],
                    timetable["date"],
                    timetable["period"],
                )

            replies = self.get_new_reflection_replies()
            logger.info("取得した返信一覧を出力します: %s件", len(replies))
            for reply in replies:
                logger.info(
                    "日付: %s, 授業名: %s, 授業Id: %s, レポート名: %s, レポートId: %s",
                    reply["date"],
                    reply["course_name"],
                    reply["courseId"],
                    reply["report_name"],
                    reply["lectureId"],
                )

            reports = self.get_unsubmitted_reports()
            logger.info("取得した未提出レポート一覧を出力します: %s件", len(reports))
            for report in reports:
                logger.info(
                    "授業名: %s, 授業Id: %s, レポート名: %s, レポートId: %s, 開始時間: %s, 提出期限: %s",
                    report["course_name"],
                    report["courseId"],
                    report["report_name"],
                    report["lectureId"],
                    report["start_at"],
                    report["end_at"],
                )

        finally:
            self.close()
            logger.debug("run処理を終了します")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )
    logger.debug("アプリケーションを開始します")
    client = PortalClient.from_env()
    client.run()


if __name__ == "__main__":
    main()
