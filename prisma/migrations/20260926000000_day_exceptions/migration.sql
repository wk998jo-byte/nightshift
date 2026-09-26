-- CreateEnum
CREATE TYPE "DayExceptionType" AS ENUM (
  'HOLIDAY',
  'ABSENT',
  'NEW',
  'SICK_LEAVE',
  'UMRA_LEAVE',
  'HALF_DAY',
  'EMERGENCY_VACATION',
  'VACATION',
  'RELEASED'
);

-- CreateTable
CREATE TABLE "DayException" (
    "id" TEXT NOT NULL,
    "workDate" TEXT NOT NULL,
    "employeeId" TEXT,
    "type" "DayExceptionType" NOT NULL,
    "reason" TEXT,
    "expectedStartTime" TEXT,
    "expectedEndTime" TEXT,
    "expectedWorkMinutes" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DayException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DayException_workDate_idx" ON "DayException"("workDate");

-- CreateIndex
CREATE INDEX "DayException_employeeId_workDate_idx" ON "DayException"("employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "DayException_employee_date_unique" ON "DayException"("employeeId", "workDate") WHERE "employeeId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DayException_holiday_date_unique" ON "DayException"("workDate") WHERE "employeeId" IS NULL AND "type" = 'HOLIDAY';

-- AddForeignKey
ALTER TABLE "DayException" ADD CONSTRAINT "DayException_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayException" ADD CONSTRAINT "DayException_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
