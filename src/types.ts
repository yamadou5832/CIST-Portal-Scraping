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
  unsubmitted_reports: UnsubmittedReport[];
  new_reflection_replies: ReflectionReply[];
  timetable: TimetableEntry[];
}
