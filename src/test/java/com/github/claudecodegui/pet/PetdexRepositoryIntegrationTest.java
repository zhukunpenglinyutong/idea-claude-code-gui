package com.github.claudecodegui.pet;

import org.junit.Assume;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertTrue;

/** Opt-in network verification for the production Petdex download and install path. */
public class PetdexRepositoryIntegrationTest {

    @Test
    public void downloadsPreviewAndInstallsKnownPetsIntoIsolatedHome() throws Exception {
        Assume.assumeTrue("1".equals(System.getenv("PETDEX_INTEGRATION")));
        String expectedHome = System.getenv("PETDEX_INTEGRATION_HOME");
        Assume.assumeTrue(expectedHome != null && !expectedHome.trim().isEmpty());
        assertTrue(Path.of(expectedHome).toAbsolutePath().normalize()
                .equals(Path.of(System.getenv("USERPROFILE")).toAbsolutePath().normalize()));

        PetdexRepository repository = new PetdexRepository();
        repository.configureNetwork(30, 90, 1);
        assertTrue(repository.getCatalog(true).size() > 1000);
        assertTrue(repository.getPreviewDataUrl("dalek").startsWith("data:image/png;base64,"));

        Path petRoot = Path.of(expectedHome, ".codex", "pets");
        try {
            verifyInstall(repository, petRoot, "dalek");
            verifyInstall(repository, petRoot, "mecha-xiaobai");
        } finally {
            uninstallIfPresent(repository, petRoot, "dalek");
            uninstallIfPresent(repository, petRoot, "mecha-xiaobai");
        }
    }

    private static void verifyInstall(PetdexRepository repository, Path petRoot, String slug) throws Exception {
        PetdexRepository.InstallResult result = repository.install(slug);
        Path installedImage = petRoot.resolve(result.getPetId()).normalize();
        assertTrue(installedImage.startsWith(petRoot.toAbsolutePath().normalize()));
        assertTrue(Files.isRegularFile(installedImage));
        assertTrue(Files.size(installedImage) > 0L);
        assertTrue(Files.isRegularFile(installedImage.getParent().resolve("pet.json")));
    }

    private static void uninstallIfPresent(PetdexRepository repository, Path petRoot, String slug) throws Exception {
        if (Files.isDirectory(petRoot.resolve(slug))) {
            repository.uninstall(slug);
        }
    }
}
