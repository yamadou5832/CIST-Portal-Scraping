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

export interface MyPageData {
  unsubmitted_reports: UnsubmittedReport[];
  new_reflection_replies: ReflectionReply[];
  timetable: TimetableEntry[];
}
