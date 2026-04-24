const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Début de la migration vers v2.0...");

  try {
    // 1. Vérifier la connexion
    await prisma.$connect();
    console.log("✅ Connexion à la base de données établie");

    // 2. Compter les données existantes
    const userCount = await prisma.user.count();
    const activityCount = await prisma.activity.count();
    console.log(
      `📊 Données existantes : ${userCount} utilisateurs, ${activityCount} activités`,
    );

    // 3. Mettre à jour les activités sans creatorId
    const updated = await prisma.activity.updateMany({
      where: { creatorId: null },
      data: { isSupervisorCreated: false },
    });
    console.log(`✅ ${updated.count} activités mises à jour`);

    console.log("🎉 Migration terminée avec succès !");
  } catch (error) {
    console.error("❌ Erreur de migration:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main();
