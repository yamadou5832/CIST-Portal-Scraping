export interface UnsubmittedReport {
  course_name: string;
  courseId: string;
  report_name: string;
  lectureId: string;
  start_at: string;
  end_at: string;
}

export interface ReflectionReply {
  date: string;
  course_name: string;
  courseId: string;
  report_name: string;
  lectureId: string;
}

export interface TimetableEntry {
  classroom: string;
  course_name: string;
  courseId: string;
  datetime: string;
  period: number;
}

export interface MyPageNewInformationSummary {
  required_office_memo_count: number;
  unread_office_memo_count: number;
  unaccepted_schedule_count: number;
  unanswered_questionnaire_count: number;
}

export interface UnsubmittedReportSummary {
  due_within_week_count: number;
  total_count: number;
}

export interface PendingAppointmentSummary {
  pending_count: number;
  has_pending_items: boolean;
}

export interface UndoneQuestionnaire {
  questionnaireId: string;
  title: string;
  deadline_at: string | null;
  is_closed: boolean;
  is_anonymous: boolean;
  is_repeatable: boolean;
  category: string;
}

export interface OfficeMemoAttachment {
  name: string;
  url: string;
}

export interface ReceivedOfficeMemoDetail extends ReceivedOfficeMemo {
  author: string;
  body: string;
  posted_at: string | null;
  expires_at: string | null;
  attachments: OfficeMemoAttachment[];
}

export interface MonthlyScheduleEvent {
  date: string;
  title: string;
  cssClass: string;
}

export interface MonthlySchedule {
  month: string;
  events: MonthlyScheduleEvent[];
}

export interface CourseSummary {
  courseId: string;
  code: string;
  department: string;
  grade: string;
  semester: string;
  category: string;
  course_name: string;
}

export interface LectureAttachment {
  name: string;
  url: string;
}

export interface LectureSessionDetail {
  title: string;
  schedule_date: string;
  period: string;
  classroom: string;
  description: string;
  attendance_status: string;
  attachments: LectureAttachment[];
}

export interface CourseLectureDetail {
  courseId: string;
  course_name: string;
  teacher: string;
  notes: string;
  sessions: LectureSessionDetail[];
}

export interface DistributionPdfItem {
  title: string;
  url: string;
}

export interface DistributionPdfGroup {
  genre: string;
  items: DistributionPdfItem[];
}

export type OfficeMemoFilter = "all" | "unread" | "read" | "star";

export const OFFICE_MEMO_DEFAULT_LIMIT = 10;
export const OFFICE_MEMO_PORTAL_PAGE_SIZE = 10;

export interface ReceivedOfficeMemo {
  title: string;
  officeMemoId: string;
  category: string;
  date: Date;
  isBookmarked: boolean;
  isReviewNeeded: boolean;
  isUnread: boolean;
  isUpdated: boolean;
  isImportant: boolean;
}

export interface FetchReceivedOfficeMemosOptions {
  page?: number;
  limit?: number;
  filter?: OfficeMemoFilter;
  searchKeyword?: string;
  categoryFilter?: string;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedReceivedOfficeMemos {
  items: ReceivedOfficeMemo[];
  pagination: PaginationInfo;
}

export interface MyPageData {
  new_information: MyPageNewInformationSummary;
  unsubmitted_report_summary: UnsubmittedReportSummary;
  unsubmitted_reports: UnsubmittedReport[];
  new_reflection_replies: ReflectionReply[];
  timetable: TimetableEntry[];
}
