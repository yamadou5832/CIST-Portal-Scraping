import os
import pickle
import time
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv
from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from url_normalize import url_normalize


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

    @classmethod
    def from_env(cls) -> "PortalClient":
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

    def start(self) -> None:
        self.driver = webdriver.Chrome()
        self.driver.implicitly_wait(30)
        self.driver.get(self.config.portal_url)
        self._load_cookies()

    def _load_cookies(self) -> None:
        if self.driver is None:
            return

        if os.path.exists(self.config.cookie_path):
            with open(self.config.cookie_path, "rb") as f:
                cookies = pickle.load(f)
                for cookie in cookies:
                    self.driver.add_cookie(cookie)
            self.driver.refresh()

    def _save_cookies(self) -> None:
        if self.driver is None:
            return

        cookies = self.driver.get_cookies()
        with open(self.config.cookie_path, "wb") as f:
            pickle.dump(cookies, f)

    def login(self) -> bool:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        self.driver.get(self.target_url)
        time.sleep(2)

        current_url = self._normalize_url_for_check(self.driver.current_url)
        print(f"現在のURL: {current_url}")

        if current_url == self._normalize_url_for_check(self.target_url):
            return True

        if current_url == self._normalize_url_for_check(self.login_url):
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
            print(f"現在のURL: {current_url}")
            if current_url == self._normalize_url_for_check(self.target_url):
                return True

        return False

    def check_login_status(self) -> bool:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        print("MyPageへアクセスを試みます...")
        self.driver.get(self.target_url)

        time.sleep(2)

        current_url = self._normalize_url_for_check(self.driver.current_url)
        print(f"現在のURL: {current_url}")

        normalized_target_url = self._normalize_url_for_check(self.target_url)
        normalized_login_url = self._normalize_url_for_check(self.login_url)

        if current_url == normalized_target_url:
            print("判定結果: ログイン済みです！")
            return True
        if current_url.startswith(normalized_login_url):
            print("判定結果: 未ログインです（ログインページに飛ばされました）")
            return False

        print("判定結果: 予期しないページに遷移しました")
        return False

    def get_notification_counts(self):
        if self.driver is None:
            raise RuntimeError("Driver is not started")

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

        except NoSuchElementException as e:
            print(f"要素が見つかりませんでした: {e}")
        except ValueError:
            print("件数のテキストを数値に変換できませんでした")

        return counts

    def get_messages(
        self,
        filter_type: Literal["all", "unread", "read", "star"] = "all",
        current_page: int = 1,
    ) -> list[dict]:
        if self.driver is None:
            raise RuntimeError("Driver is not started")

        target_url = self.build_officememo_url(
            filter_type=filter_type,
            current_page=current_page,
        )
        self.driver.get(target_url)
        messages = []

        # メッセージのカード要素をすべて取得
        cards = self.driver.find_elements(By.CSS_SELECTOR, "#commonViewReceivedTitles .card.flex-row")

        for card in cards:
            try:
                # 1. タイトルとリンクURL
                title_element = card.find_element(By.CSS_SELECTOR, "a.no-underline")
                title = title_element.text.strip()
                link_url = title_element.get_attribute("href")

                # 2. メッセージID（チェックボックスのID属性から取得）
                checkbox = card.find_element(By.CSS_SELECTOR, "input.bulk_operations")
                message_id = checkbox.get_attribute("id")

                # 3. 未読ステータス（要素が存在すれば未読）
                # find_elements（複数形）を使うことで、要素がない場合でもエラーにならず空リストが返る
                is_unread = (
                    len(
                        card.find_elements(
                            By.XPATH, ".//span[contains(text(), '未読')]"
                        )
                    )
                    > 0
                )

                # 4. 重要フラグ（要素が存在すれば重要）
                is_important = (
                    len(
                        card.find_elements(
                            By.XPATH, ".//span[contains(text(), '重要')]"
                        )
                    )
                    > 0
                )

                # 5. 更新ありフラグ
                is_updated = (
                    len(
                        card.find_elements(
                            By.XPATH, ".//span[contains(text(), '更新あり')]"
                        )
                    )
                    > 0
                )

                # 6. カテゴリ（タグアイコンの隣にあるspanテキスト）
                try:
                    category = card.find_element(
                        By.XPATH,
                        ".//i[contains(@class, 'bi-tag')]/following-sibling::span",
                    ).text
                except:
                    category = "なし"

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
                    }
                )

            except Exception as e:
                print(
                    f"メッセージの抽出中にエラーが発生しました (ID: {message_id if 'message_id' in locals() else '不明'}): {e}"
                )
                continue

        return messages

    def close(self) -> None:
        if self.driver is None:
            return

        self._save_cookies()
        self.driver.quit()
        self.driver = None

    def run(self) -> None:
        self.start()
        try:
            if not self.login():
                print("ログインに失敗しました")
                raise Exception("ログインに失敗しました")

            if not self.check_login_status():
                print("ログインに失敗しました")
                raise Exception("ログインに失敗しました")

            counts = self.get_notification_counts()
            print(
                f"連絡: {counts['memo']}件, 予定: {counts['schedule']}件, アンケート: {counts['questionnaire']}件"
            )

            messages = self.get_messages(filter_type="all")
            for msg in messages:
                print(
                    f"タイトル: {msg['title']}, 未読: {msg['is_unread']}, 重要: {msg['is_important']}"
                )

        finally:
            self.close()


def main() -> None:
    client = PortalClient.from_env()
    client.run()


if __name__ == "__main__":
    main()
