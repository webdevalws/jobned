import type { APIRoute } from "astro";
import { getDb } from "../../../lib/db";
import { applications, users, jobPostings } from "../../../db/schema";
import { eq, desc, asc, and, gte, lte, like, or, ne, notLike } from "drizzle-orm";

export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user || (user.userType !== "superadmin" && user.userType !== "masteradmin")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = getDb();
  
  const url = new URL(context.request.url);
  const jobTitle = url.searchParams.get("jobTitle");
  const positionParam = url.searchParams.get("position");
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  
  // SuperAdmin is strictly restricted to platform applications only. MasterAdmin can export any source.
  let sourceParam = url.searchParams.get("source") || "platform";
  if (user.userType === "superadmin") {
    sourceParam = "platform";
  }

  const conditions = [];
  
  // Source filtering
  if (sourceParam === "alightway" && user.userType === "masteradmin") {
    conditions.push(or(eq(users.userType, "external_applicant"), like(jobPostings.id, "external_%")));
  } else if (sourceParam === "platform") {
    conditions.push(and(ne(users.userType, "external_applicant"), notLike(jobPostings.id, "external_%")));
  }
  
  // Position filtering
  if (positionParam && positionParam !== "all") {
    conditions.push(eq(jobPostings.jobTitle, positionParam));
  }

  if (jobTitle) {
    conditions.push(like(jobPostings.jobTitle, `%${jobTitle}%`));
  }
  
  if (fromDate) {
    const fromTimestamp = new Date(fromDate).getTime();
    if (!isNaN(fromTimestamp)) {
      conditions.push(gte(applications.appliedAt, new Date(fromTimestamp)));
    }
  }
  
  if (toDate) {
    const toDateObj = new Date(toDate);
    toDateObj.setHours(23, 59, 59, 999);
    const toTimestamp = toDateObj.getTime();
    if (!isNaN(toTimestamp)) {
      conditions.push(lte(applications.appliedAt, new Date(toTimestamp)));
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const sortParam = url.searchParams.get("sort") || "date_desc";
  let orderByClause = desc(applications.appliedAt);
  
  if (sortParam === "date_asc") {
    orderByClause = asc(applications.appliedAt);
  } else if (sortParam === "status_asc") {
    orderByClause = asc(applications.status);
  } else if (sortParam === "status_desc") {
    orderByClause = desc(applications.status);
  } else if (sortParam === "name_asc") {
    orderByClause = asc(users.firstName);
  } else if (sortParam === "name_desc") {
    orderByClause = desc(users.firstName);
  }

  const apps = await db
    .select({
      id: applications.id,
      status: applications.status,
      appliedAt: applications.appliedAt,
      applicantFirstName: users.firstName,
      applicantLastName: users.lastName,
      applicantEmail: users.email,
      applicantPhone: users.phone,
      userType: users.userType,
      jobTitle: jobPostings.jobTitle,
      jobId: jobPostings.id,
      resumeUrl: applications.resumeUrl,
      coverLetter: applications.coverLetter,
      notes: applications.notes,
    })
    .from(applications)
    .innerJoin(users, eq(applications.applicantId, users.id))
    .innerJoin(jobPostings, eq(applications.jobPostingId, jobPostings.id))
    .where(whereClause)
    .orderBy(orderByClause);

  // Generate CSV Content
  const csvHeaders = ["Application ID", "Source", "Applicant Name", "Email", "Phone", "Job Title", "Status", "Applied Date", "Resume Link", "Notes"];
  
  const csvRows = apps.map(app => {
    const isAlightway = app.userType === "external_applicant" || (app.jobId && app.jobId.startsWith("external_")) || (app.notes && app.notes.includes("Alightway"));
    const source = isAlightway ? "Alightway Website" : "JobNed Platform";
    const name = `"${app.applicantFirstName || ''} ${app.applicantLastName || ''}"`.trim();
    const email = `"${app.applicantEmail || ''}"`;
    const phone = `"${app.applicantPhone || ''}"`;
    const title = `"${(app.jobTitle || '').replace(/"/g, '""')}"`;
    const status = `"${app.status || ''}"`;
    const date = app.appliedAt ? `"${new Date(app.appliedAt).toISOString()}"` : '""';
    const resume = `"${app.resumeUrl || ''}"`;
    const notes = `"${(app.notes || '').replace(/"/g, '""')}"`;

    return [app.id, source, name, email, phone, title, status, date, resume, notes].join(",");
  });

  const csvContent = [csvHeaders.join(","), ...csvRows].join("\n");

  return new Response(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="applications-export-${sourceParam}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
