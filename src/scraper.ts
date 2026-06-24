import path from "node:path";

import type { PortalUserCredentials } from "./auth/types.js";
import type { AppConfig } from "./config.js";
import { CourseScraper } from "./portal/course-scraper.js";
import { MyPageScraper } from "./portal/mypage-scraper.js";
import { OfficeMemoScraper } from "./portal/office-memo-scraper.js";
import { PortalBrowserSession } from "./portal/browser-session.js";
import { ResourceScraper } from "./portal/resource-scraper.js";
import { ScheduleScraper } from "./portal/schedule-scraper.js";
import type {
  CourseLectureAttendanceResult,
  CourseLectureDetail,
  CourseSummary,
  DistributionPdfGroup,
  FetchReceivedOfficeMemosOptions,
  MyPageData,
  MyPageNewInformationSummary,
  MonthlySchedule,
  PaginatedReceivedOfficeMemos,
  PendingAppointmentSummary,
  ReceivedOfficeMemoDetail,
  ReflectionReply,
  TimetableEntry,
  UndoneQuestionnaire,
  UnsubmittedReport,
  UnsubmittedReportSummary,
} from "./types.js";

class UserPortalScraper {
  private readonly session: PortalBrowserSession;
  private readonly myPage: MyPageScraper;
  private readonly officeMemos: OfficeMemoScraper;
  private readonly schedule: ScheduleScraper;
  private readonly courses: CourseScraper;
  private readonly resources: ResourceScraper;

  constructor(config: AppConfig, credentials: PortalUserCredentials, storageStatePath: string) {
    this.session = new PortalBrowserSession(config, credentials, storageStatePath);
    this.myPage = new MyPageScraper(this.session);
    this.officeMemos = new OfficeMemoScraper(this.session, config.portalUrl);
    this.schedule = new ScheduleScraper(this.session, config.portalUrl);
    this.courses = new CourseScraper(this.session, config.portalUrl);
    this.resources = new ResourceScraper(this.session, config.portalUrl);
  }

  close(): Promise<void> {
    return this.session.close();
  }

  fetchMyPageData(): Promise<MyPageData> {
    return this.myPage.fetchMyPageData();
  }

  fetchMyPageNewInformationSummary(): Promise<MyPageNewInformationSummary> {
    return this.myPage.fetchMyPageNewInformationSummary();
  }

  fetchUnsubmittedReportSummary(): Promise<UnsubmittedReportSummary> {
    return this.myPage.fetchUnsubmittedReportSummary();
  }

  fetchMyPageSummaries(): Promise<Pick<MyPageData, "new_information" | "unsubmitted_report_summary">> {
    return this.myPage.fetchMyPageSummaries();
  }

  fetchUnsubmittedReports(): Promise<UnsubmittedReport[]> {
    return this.myPage.fetchUnsubmittedReports();
  }

  fetchReflectionReplies(): Promise<ReflectionReply[]> {
    return this.myPage.fetchReflectionReplies();
  }

  fetchTimetable(): Promise<TimetableEntry[]> {
    return this.myPage.fetchTimetable();
  }

  fetchReceivedOfficeMemos(options: FetchReceivedOfficeMemosOptions = {}): Promise<PaginatedReceivedOfficeMemos> {
    return this.officeMemos.fetchReceivedOfficeMemos(options);
  }

  fetchReceivedOfficeMemoDetails(options: FetchReceivedOfficeMemosOptions = {}): Promise<ReceivedOfficeMemoDetail[]> {
    return this.officeMemos.fetchReceivedOfficeMemoDetails(options);
  }

  fetchReceivedOfficeMemoDetail(officeMemoId: string): Promise<ReceivedOfficeMemoDetail> {
    return this.officeMemos.fetchReceivedOfficeMemoDetail(officeMemoId);
  }

  fetchMonthlySchedule(): Promise<MonthlySchedule> {
    return this.schedule.fetchMonthlySchedule();
  }

  fetchPendingAppointmentsSummary(): Promise<PendingAppointmentSummary> {
    return this.schedule.fetchPendingAppointmentsSummary();
  }

  fetchUndoneQuestionnaires(): Promise<UndoneQuestionnaire[]> {
    return this.resources.fetchUndoneQuestionnaires();
  }

  fetchCoursesForUser(): Promise<CourseSummary[]> {
    return this.courses.fetchCoursesForUser();
  }

  fetchCourseLectureDetails(options: { courseId?: string; session?: number } = {}): Promise<CourseLectureDetail[]> {
    return this.courses.fetchCourseLectureDetails(options);
  }

  registerCourseLectureAttendance(options: { lectureId: string; password: string }): Promise<CourseLectureAttendanceResult> {
    return this.courses.registerCourseLectureAttendance(options);
  }

  fetchDistributionPdfUrls(): Promise<DistributionPdfGroup[]> {
    return this.resources.fetchDistributionPdfUrls();
  }
}

export class PortalScraperService {
  private readonly scrapers = new Map<string, UserPortalScraper>();

  constructor(private readonly config: AppConfig) {}

  async close(): Promise<void> {
    await Promise.all([...this.scrapers.values()].map((scraper) => scraper.close()));
    this.scrapers.clear();
  }

  fetchMyPageData(user: PortalUserCredentials): Promise<MyPageData> {
    return this.forUser(user).fetchMyPageData();
  }

  fetchMyPageNewInformationSummary(user: PortalUserCredentials): Promise<MyPageNewInformationSummary> {
    return this.forUser(user).fetchMyPageNewInformationSummary();
  }

  fetchUnsubmittedReportSummary(user: PortalUserCredentials): Promise<UnsubmittedReportSummary> {
    return this.forUser(user).fetchUnsubmittedReportSummary();
  }

  fetchMyPageSummaries(user: PortalUserCredentials): Promise<Pick<MyPageData, "new_information" | "unsubmitted_report_summary">> {
    return this.forUser(user).fetchMyPageSummaries();
  }

  fetchUnsubmittedReports(user: PortalUserCredentials): Promise<UnsubmittedReport[]> {
    return this.forUser(user).fetchUnsubmittedReports();
  }

  fetchReflectionReplies(user: PortalUserCredentials): Promise<ReflectionReply[]> {
    return this.forUser(user).fetchReflectionReplies();
  }

  fetchTimetable(user: PortalUserCredentials): Promise<TimetableEntry[]> {
    return this.forUser(user).fetchTimetable();
  }

  fetchReceivedOfficeMemos(
    user: PortalUserCredentials,
    options: FetchReceivedOfficeMemosOptions = {},
  ): Promise<PaginatedReceivedOfficeMemos> {
    return this.forUser(user).fetchReceivedOfficeMemos(options);
  }

  fetchReceivedOfficeMemoDetails(
    user: PortalUserCredentials,
    options: FetchReceivedOfficeMemosOptions = {},
  ): Promise<ReceivedOfficeMemoDetail[]> {
    return this.forUser(user).fetchReceivedOfficeMemoDetails(options);
  }

  fetchReceivedOfficeMemoDetail(user: PortalUserCredentials, officeMemoId: string): Promise<ReceivedOfficeMemoDetail> {
    return this.forUser(user).fetchReceivedOfficeMemoDetail(officeMemoId);
  }

  fetchMonthlySchedule(user: PortalUserCredentials): Promise<MonthlySchedule> {
    return this.forUser(user).fetchMonthlySchedule();
  }

  fetchPendingAppointmentsSummary(user: PortalUserCredentials): Promise<PendingAppointmentSummary> {
    return this.forUser(user).fetchPendingAppointmentsSummary();
  }

  fetchUndoneQuestionnaires(user: PortalUserCredentials): Promise<UndoneQuestionnaire[]> {
    return this.forUser(user).fetchUndoneQuestionnaires();
  }

  fetchCoursesForUser(user: PortalUserCredentials): Promise<CourseSummary[]> {
    return this.forUser(user).fetchCoursesForUser();
  }

  fetchCourseLectureDetails(user: PortalUserCredentials, options: { courseId?: string; session?: number } = {}): Promise<CourseLectureDetail[]> {
    return this.forUser(user).fetchCourseLectureDetails(options);
  }

  registerCourseLectureAttendance(
    user: PortalUserCredentials,
    options: { lectureId: string; password: string },
  ): Promise<CourseLectureAttendanceResult> {
    return this.forUser(user).registerCourseLectureAttendance(options);
  }

  fetchDistributionPdfUrls(user: PortalUserCredentials): Promise<DistributionPdfGroup[]> {
    return this.forUser(user).fetchDistributionPdfUrls();
  }

  private forUser(credentials: PortalUserCredentials): UserPortalScraper {
    const existing = this.scrapers.get(credentials.id);
    if (existing) {
      return existing;
    }

    const scraper = new UserPortalScraper(this.config, credentials, this.storageStatePathForUser(credentials.id));
    this.scrapers.set(credentials.id, scraper);
    return scraper;
  }

  private storageStatePathForUser(userId: string): string {
    return path.join(path.dirname(this.config.storageStatePath), "users", `${userId}.json`);
  }
}
