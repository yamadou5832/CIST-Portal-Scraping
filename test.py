import os
import pickle
import time
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv
from selenium import webdriver
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

    @staticmethod
    def _normalize_url(url: str) -> str:
        return url_normalize(url)

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

            time.sleep(10)
        finally:
            self.close()


def main() -> None:
    client = PortalClient.from_env()
    client.run()


if __name__ == "__main__":
    main()
