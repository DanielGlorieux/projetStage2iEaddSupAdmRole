const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || "votre_secret_jwt_très_sécurisé";
const ACTIVITY_TYPES = ["entrepreneuriat", "leadership", "digital"];

const normalizeRole = (role) => String(role || "").toLowerCase();

const getSuperAdminDomain = (role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole.startsWith("super_admin_")) {
    return null;
  }

  const domain = normalizedRole.replace("super_admin_", "");
  return ACTIVITY_TYPES.includes(domain) ? domain : null;
};

const isSuperAdmin = (role) => Boolean(getSuperAdminDomain(role));

const getAccessibleActivityTypes = (user) => {
  const domain = getSuperAdminDomain(user?.role);
  return domain ? [domain] : [...ACTIVITY_TYPES];
};

const authorizeSuperAdminDomain = (resolveType) => {
  return (req, res, next) => {
    const userDomain = getSuperAdminDomain(req.user?.role);
    if (!userDomain) {
      return next();
    }

    const rawType =
      typeof resolveType === "function" ? resolveType(req) : req.body?.[resolveType];

    if (!rawType) {
      return next();
    }

    const normalizedType = String(rawType).toLowerCase();
    if (!ACTIVITY_TYPES.includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        error: "Type d'activité invalide",
      });
    }

    if (normalizedType !== userDomain) {
      return res.status(403).json({
        success: false,
        error: "Accès refusé",
        message: `Vous êtes super admin ${userDomain} et ne pouvez accéder qu'à ce domaine.`,
      });
    }

    next();
  };
};

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Token d'authentification manquant",
      });
    }

    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Token manquant",
      });
    }

    // Vérifier le token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Vérifier que l'utilisateur existe toujours
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        specialization: true,
        filiere: true,
        niveau: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Utilisateur non trouvé",
      });
    }

    // Ajouter les informations de l'utilisateur à la requête
    req.user = {
      id: user.id,
      userId: user.id, // Garder pour rétrocompatibilité
      email: user.email,
      role: normalizeRole(user.role),
      specialization: user.specialization
        ? String(user.specialization).toLowerCase()
        : null,
      name: user.name,
      filiere: user.filiere,
      niveau: user.niveau,
    };

    next();
  } catch (error) {
    console.error("Erreur d'authentification:", error);

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        error: "Token invalide",
      });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Token expiré",
      });
    }

    res.status(500).json({
      success: false,
      error: "Erreur lors de la vérification du token",
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Non authentifié",
      });
    }

    const normalizedRoles = roles.map((role) => normalizeRole(role));
    const userRole = normalizeRole(req.user.role);

    const userIsSuperAdmin = isSuperAdmin(userRole);

    if (userIsSuperAdmin) {
      // Les super admins peuvent accéder aux routes de gestion globales.
      if (
        normalizedRoles.includes("led_team") ||
        normalizedRoles.includes("supervisor")
      ) {
        return next();
      }
    }

    if (!normalizedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: "Accès refusé",
        message: `Rôle requis: ${roles.join(" ou ")}`,
      });
    }

    next();
  };
};

// Middleware spécifique pour vérifier les droits de super admin sur un type d'activité
const authorizeSuperAdminForType = (activityType) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Non authentifié",
      });
    }

    const userRole = normalizeRole(req.user.role);

    // LED team a tous les droits
    if (userRole === "led_team") {
      return next();
    }

    // Vérifier si c'est un super admin avec la bonne spécialisation
    const expectedRole = `super_admin_${String(activityType).toLowerCase()}`;
    if (userRole === expectedRole) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: "Accès refusé",
      message: `Super admin ${activityType} requis pour cette action`,
    });
  };
};

module.exports = {
  ACTIVITY_TYPES,
  authenticate,
  authorize,
  isSuperAdmin,
  getSuperAdminDomain,
  getAccessibleActivityTypes,
  authorizeSuperAdminDomain,
  authorizeSuperAdminForType,
};
