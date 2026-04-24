const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { body, validationResult } = require("express-validator");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const {
  authenticate,
  authorize,
  getSuperAdminDomain,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticate);

const ACTIVITY_TYPES = ["entrepreneuriat", "leadership", "digital"];
const ACTIVITY_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "submitted",
  "evaluated",
  "cancelled",
];

const toArray = (value) => {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((item) => String(item).trim());
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const toSearchTerms = (value) => {
  if (!value) return [];
  const text = Array.isArray(value) ? value.join(" ") : String(value);
  return text
    .split(/[,\s]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
};

const buildUserWhere = (filters = {}) => {
  const where = { role: "student" };

  if (filters.nom) {
    where.name = { contains: String(filters.nom).trim() };
  }
  if (filters.email) {
    where.email = { contains: String(filters.email).trim() };
  }

  const filieres = toArray(filters.filiere);
  if (filieres.length > 0) {
    where.filiere = { in: filieres };
  }

  const niveaux = toArray(filters.niveau);
  if (niveaux.length > 0) {
    where.niveau = { in: niveaux };
  }

  return where;
};

const buildActivityWhere = (filters = {}, userDomain = null) => {
  const where = {};
  const andClauses = [];

  const requestedTypes = toArray(filters.typeActivite).map((type) =>
    type.toLowerCase()
  );
  if (userDomain) {
    if (
      requestedTypes.length > 0 &&
      requestedTypes.some((type) => type !== userDomain)
    ) {
      return { error: `Vous êtes super admin ${userDomain} et ne pouvez filtrer que ce domaine.` };
    }
    where.type = userDomain;
  } else if (requestedTypes.length > 0) {
    where.type = { in: requestedTypes };
  }

  const statuses = toArray(filters.statut).map((status) => status.toLowerCase());
  if (statuses.length > 0) {
    where.status = { in: statuses };
  }

  if (filters.periodeDebut || filters.periodeFin) {
    where.createdAt = {};
    if (filters.periodeDebut) {
      where.createdAt.gte = new Date(filters.periodeDebut);
    }
    if (filters.periodeFin) {
      where.createdAt.lte = new Date(filters.periodeFin);
    }
  }

  const keywordTerms = toSearchTerms(filters.keywords);
  keywordTerms.forEach((term) => {
    andClauses.push({
      OR: [
        { title: { contains: term } },
        { description: { contains: term } },
        { keywords: { contains: term } },
        { tags: { contains: term } },
        { objectives: { contains: term } },
        { learnings: { contains: term } },
        { competencies: { contains: term } },
      ],
    });
  });

  const competenceTerms = toSearchTerms(filters.competences);
  competenceTerms.forEach((term) => {
    andClauses.push({
      OR: [
        { competencies: { contains: term } },
        { learnings: { contains: term } },
        { tags: { contains: term } },
      ],
    });
  });

  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  return { where };
};

const aggregateScores = (activities) => {
  const scores = { entrepreneuriat: 0, leadership: 0, digital: 0 };
  const counts = { entrepreneuriat: 0, leadership: 0, digital: 0 };

  activities.forEach((activity) => {
    if (activity.evaluations.length === 0) return;
    const type = String(activity.type || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(scores, type)) return;

    scores[type] += activity.evaluations[0].score;
    counts[type] += 1;
  });

  Object.keys(scores).forEach((type) => {
    if (counts[type] > 0) {
      scores[type] = Math.round(scores[type] / counts[type]);
    }
  });

  const values = Object.keys(scores)
    .filter((type) => counts[type] > 0)
    .map((type) => scores[type]);

  const scoreGlobal =
    values.length > 0
      ? Math.round(values.reduce((sum, score) => sum + score, 0) / values.length)
      : 0;

  return { scores, scoreGlobal };
};

const mapStudentToSearchResult = (student) => {
  const activities = student.activities || [];
  const { scores, scoreGlobal } = aggregateScores(activities);

  return {
    id: student.id,
    nom: student.name,
    email: student.email,
    filiere: student.filiere || "",
    niveau: student.niveau || "",
    scoreGlobal,
    statut: "actif",
    dernierAcces: student.updatedAt,
    activitesCompletes: activities.filter((a) => a.status === "evaluated").length,
    activitesTotal: activities.length,
    competences: scores,
  };
};

const enforceScoreRange = (result, filters = {}) => {
  if (
    filters.scoreMin !== undefined &&
    filters.scoreMin !== null &&
    result.scoreGlobal < Number(filters.scoreMin)
  ) {
    return false;
  }
  if (
    filters.scoreMax !== undefined &&
    filters.scoreMax !== null &&
    result.scoreGlobal > Number(filters.scoreMax)
  ) {
    return false;
  }
  return true;
};

const fetchStudentsForSearch = async ({ filters = {}, studentIds, userDomain }) => {
  const userWhere = buildUserWhere(filters);
  if (studentIds && studentIds.length > 0) {
    userWhere.id = { in: studentIds };
  }

  const activityWhereResult = buildActivityWhere(filters, userDomain);
  if (activityWhereResult.error) {
    return { error: activityWhereResult.error };
  }

  const students = await prisma.user.findMany({
    where: userWhere,
    include: {
      activities: {
        where: activityWhereResult.where,
        include: { evaluations: true },
      },
    },
  });

  return { data: students };
};

// GET /api/search/stats
router.get(
  "/stats",
  authorize("led_team", "supervisor"),
  async (req, res, next) => {
    try {
      const userDomain = getSuperAdminDomain(req.user.role);

      const totalStudents = await prisma.user.count({
        where: { role: "student" },
      });

      const studentsWithActivities = await prisma.user.count({
        where: {
          role: "student",
          activities: {
            some: userDomain ? { type: userDomain } : {},
          },
        },
      });

      const totalActivities = await prisma.activity.count({
        where: userDomain ? { type: userDomain } : {},
      });

      const activitiesByStatus = await prisma.activity.groupBy({
        by: ["status"],
        where: userDomain ? { type: userDomain } : {},
        _count: { id: true },
      });

      const activitiesByType = await prisma.activity.groupBy({
        by: ["type"],
        where: userDomain ? { type: userDomain } : {},
        _count: { id: true },
      });

      const evaluations = await prisma.evaluation.findMany({
        where: userDomain
          ? { activity: { type: userDomain } }
          : undefined,
        select: {
          score: true,
          activity: { select: { type: true } },
        },
      });

      const averageScores = { entrepreneuriat: 0, leadership: 0, digital: 0 };
      const scoreCounts = { entrepreneuriat: 0, leadership: 0, digital: 0 };

      evaluations.forEach((evaluation) => {
        const type = String(evaluation.activity?.type || "").toLowerCase();
        if (Object.prototype.hasOwnProperty.call(averageScores, type)) {
          averageScores[type] += evaluation.score;
          scoreCounts[type] += 1;
        }
      });

      Object.keys(averageScores).forEach((type) => {
        if (scoreCounts[type] > 0) {
          averageScores[type] = Math.round(averageScores[type] / scoreCounts[type]);
        }
      });

      const scoreValues = Object.keys(averageScores)
        .filter((type) => scoreCounts[type] > 0)
        .map((type) => averageScores[type]);
      const globalAverageScore =
        scoreValues.length > 0
          ? Math.round(
              scoreValues.reduce((sum, score) => sum + score, 0) /
                scoreValues.length
            )
          : 0;

      const recentActivities = await prisma.activity.findMany({
        where: userDomain ? { type: userDomain } : {},
        take: 10,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { name: true } },
        },
      });

      res.json({
        success: true,
        data: {
          totalStudents,
          studentsWithActivities,
          activeStudentsRate:
            totalStudents > 0
              ? Math.round((studentsWithActivities / totalStudents) * 100)
              : 0,
          totalActivities,
          activitiesByStatus: activitiesByStatus.reduce((acc, item) => {
            acc[item.status] = item._count.id;
            return acc;
          }, {}),
          activitiesByType: activitiesByType.reduce((acc, item) => {
            acc[item.type] = item._count.id;
            return acc;
          }, {}),
          averageScores,
          globalAverageScore,
          recentActivities: recentActivities.map((activity) => ({
            id: activity.id,
            title: activity.title,
            type: activity.type,
            status: activity.status,
            createdAt: activity.createdAt,
            user: activity.user.name,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/search/students
router.post(
  "/students",
  authorize("led_team", "supervisor"),
  async (req, res, next) => {
    try {
      const filters = req.body || {};
      const userDomain = getSuperAdminDomain(req.user.role);

      const fetchResult = await fetchStudentsForSearch({
        filters,
        userDomain,
      });

      if (fetchResult.error) {
        return res.status(403).json({
          success: false,
          error: "Accès refusé",
          message: fetchResult.error,
        });
      }

      const scopedStudents = userDomain
        ? fetchResult.data.filter((student) => (student.activities || []).length > 0)
        : fetchResult.data;

      const results = scopedStudents
        .map(mapStudentToSearchResult)
        .filter((result) => enforceScoreRange(result, filters));

      res.json({
        success: true,
        data: results,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/search/export
router.post(
  "/export",
  authorize("led_team", "supervisor"),
  [body("format").isIn(["csv", "excel", "pdf"]).withMessage("Format invalide")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: "Données invalides",
          details: errors.array(),
        });
      }

      const { studentIds = [], filters = {}, format } = req.body;
      const userDomain = getSuperAdminDomain(req.user.role);

      const fetchResult = await fetchStudentsForSearch({
        filters,
        studentIds: Array.isArray(studentIds) ? studentIds : [],
        userDomain,
      });

      if (fetchResult.error) {
        return res.status(403).json({
          success: false,
          error: "Accès refusé",
          message: fetchResult.error,
        });
      }

      const scopedStudents = userDomain
        ? fetchResult.data.filter((student) => (student.activities || []).length > 0)
        : fetchResult.data;

      const exportData = scopedStudents
        .map((student) => {
          const result = mapStudentToSearchResult(student);
          if (!enforceScoreRange(result, filters)) {
            return null;
          }

          return {
            Nom: result.nom,
            Email: result.email,
            Filière: result.filiere || "Non spécifiée",
            Niveau: result.niveau || "Non spécifié",
            "Activités complètes": result.activitesCompletes,
            "Total activités": result.activitesTotal,
            "Score Entrepreneuriat": result.competences.entrepreneuriat,
            "Score Leadership": result.competences.leadership,
            "Score Digital": result.competences.digital,
            "Score Global": result.scoreGlobal,
            "Dernier accès": new Date(result.dernierAcces).toLocaleDateString(
              "fr-FR"
            ),
            "Date création": new Date(student.createdAt).toLocaleDateString("fr-FR"),
            "Taux de completion":
              result.activitesTotal > 0
                ? `${Math.round(
                    (result.activitesCompletes / result.activitesTotal) * 100
                  )}%`
                : "0%",
          };
        })
        .filter(Boolean);

      if (format === "csv") {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const csv = XLSX.utils.sheet_to_csv(ws);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=recherche_etudiants_${Date.now()}.csv`
        );
        return res.send(`\uFEFF${csv}`);
      }

      if (format === "excel") {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(exportData);
        XLSX.utils.book_append_sheet(wb, ws, "Recherche Étudiants LED");
        const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=recherche_etudiants_${Date.now()}.xlsx`
        );
        return res.send(buffer);
      }

      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=recherche_etudiants_${Date.now()}.pdf`
      );
      doc.pipe(res);

      doc
        .fontSize(20)
        .text("Rapport de Recherche - Étudiants LED", { align: "center" });
      doc
        .fontSize(11)
        .text(
          `Généré le ${new Date().toLocaleDateString(
            "fr-FR"
          )} à ${new Date().toLocaleTimeString("fr-FR")}`,
          { align: "center" }
        );
      doc.moveDown(1.5);

      doc.fontSize(12).text(`Nombre d'étudiants: ${exportData.length}`);
      const avgScore =
        exportData.length > 0
          ? Math.round(
              exportData.reduce((sum, item) => sum + (item["Score Global"] || 0), 0) /
                exportData.length
            )
          : 0;
      doc.text(`Score global moyen: ${avgScore}/100`);
      doc.moveDown(1.5);

      exportData.forEach((student, index) => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(11).text(`${index + 1}. ${student.Nom} (${student.Email})`);
        doc
          .fontSize(9)
          .text(
            `   Filière: ${student.Filière} | Niveau: ${student.Niveau} | Score global: ${student["Score Global"]}`
          );
        doc
          .text(
            `   Activités: ${student["Activités complètes"]}/${student["Total activités"]} | Taux: ${student["Taux de completion"]}`
          );
        doc.moveDown(0.5);
      });

      doc.end();
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/search/filters
router.get(
  "/filters",
  authorize("led_team", "supervisor"),
  async (req, res, next) => {
    try {
      const userDomain = getSuperAdminDomain(req.user.role);
      const domainActivityConstraint = userDomain
        ? { activities: { some: { type: userDomain } } }
        : {};

      const filieres = await prisma.user.findMany({
        where: {
          role: "student",
          filiere: { not: null },
          ...domainActivityConstraint,
        },
        select: { filiere: true },
        distinct: ["filiere"],
      });

      const niveaux = await prisma.user.findMany({
        where: {
          role: "student",
          niveau: { not: null },
          ...domainActivityConstraint,
        },
        select: { niveau: true },
        distinct: ["niveau"],
      });

      res.json({
        success: true,
        data: {
          filieres: filieres.map((item) => item.filiere).filter(Boolean),
          niveaux: niveaux.map((item) => item.niveau).filter(Boolean),
          statuts: ACTIVITY_STATUSES,
          typesActivite: userDomain ? [userDomain] : ACTIVITY_TYPES,
          scoreRange: { min: 0, max: 100 },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/search/student/:id
router.get(
  "/student/:id",
  authorize("led_team", "supervisor"),
  async (req, res, next) => {
    try {
      const userDomain = getSuperAdminDomain(req.user.role);
      const student = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: {
          activities: {
            where: userDomain ? { type: userDomain } : {},
            include: {
              evaluations: {
                include: {
                  evaluator: {
                    select: {
                      name: true,
                      email: true,
                    },
                  },
                },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      });

      if (!student || student.role !== "student") {
        return res.status(404).json({
          success: false,
          error: "Étudiant non trouvé",
        });
      }

      if (userDomain && student.activities.length === 0) {
        return res.status(403).json({
          success: false,
          error: "Accès refusé",
          message: `Vous êtes super admin ${userDomain} et cet étudiant n'a pas d'activité dans ce domaine.`,
        });
      }

      const result = mapStudentToSearchResult(student);

      res.json({
        success: true,
        data: {
          student: {
            id: student.id,
            name: student.name,
            email: student.email,
            filiere: student.filiere,
            niveau: student.niveau,
            createdAt: student.createdAt,
            updatedAt: student.updatedAt,
          },
          statistics: {
            activitesTotal: result.activitesTotal,
            activitesCompletes: result.activitesCompletes,
            tauxCompletion:
              result.activitesTotal > 0
                ? Math.round(
                    (result.activitesCompletes / result.activitesTotal) * 100
                  )
                : 0,
            scoreGlobal: result.scoreGlobal,
            competences: result.competences,
          },
          activities: student.activities.map((activity) => ({
            ...activity,
            evaluation: activity.evaluations[0] || null,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
