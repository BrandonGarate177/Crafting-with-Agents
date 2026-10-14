package dev.agentcraft.world;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.agentcraft.world.SiteOverlook.Box;
import dev.agentcraft.world.SiteOverlook.View;
import org.junit.jupiter.api.Test;

class SiteOverlookTest {
	/** The site button's spot in the studio (east door post of the atrium). */
	private static final double BUTTON_X = 2.5;
	private static final double BUTTON_Z = 23.5;

	/** Unit look vector of a Minecraft yaw/pitch (yaw 0 = +z, 90 = -x; pitch positive = down). */
	private static double[] look(View v) {
		double yaw = Math.toRadians(v.yaw());
		double pitch = Math.toRadians(v.pitch());
		return new double[] {-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)};
	}

	/** Angle in degrees between the view direction and the ray from the eye to a point. */
	private static double angleTo(View v, double x, double y, double z) {
		double[] l = look(v);
		double dx = x - v.x();
		double dy = y - v.y();
		double dz = z - v.z();
		double len = Math.sqrt(dx * dx + dy * dy + dz * dz);
		return Math.toDegrees(Math.acos((l[0] * dx + l[1] * dy + l[2] * dz) / len));
	}

	private static double centreX(Box b) {
		return (b.minX() + b.maxX()) / 2.0;
	}

	private static double centreZ(Box b) {
		return (b.minZ() + b.maxZ()) / 2.0;
	}

	@Test
	void fallbackIsTheForemansDefaultSite() {
		// foreman/src/site.ts DEFAULT_SITE: origin 30 64 10, A to D cover x 0..31, z 0..31, up to 16 high
		assertEquals(new Box(30, 64, 10, 62, 80, 42), SiteOverlook.FALLBACK);
	}

	@Test
	void boxesUnionToTheirBounds() {
		Box a = Box.of(30, 64, 24, 32, 8, 4);
		Box b = Box.of(46, 64, 10, 16, 16, 14);
		assertEquals(new Box(30, 64, 10, 62, 80, 28), a.union(b));
	}

	@Test
	void looksAtTheMiddleOfTheBlock() {
		Box site = SiteOverlook.FALLBACK;
		View v = SiteOverlook.of(site, BUTTON_X, BUTTON_Z);
		assertEquals(0, angleTo(v, centreX(site), site.minY() + 1, centreZ(site)), 1e-3);
	}

	@Test
	void standsAboveTheBlockOnTheStudioSideLookingDown() {
		for (Box site : new Box[] {SiteOverlook.FALLBACK, Box.of(50, 64, 10, 32, 16, 32)}) {
			View v = SiteOverlook.of(site, BUTTON_X, BUTTON_Z);
			assertTrue(v.y() > site.maxY(), "eye above the tallest slot: " + v);
			assertTrue(v.x() < site.minX(), "eye on the studio (west) side: " + v);
			assertEquals(SiteOverlook.PITCH, v.pitch(), 1e-3);
			// facing roughly east (yaw -90), toward the site
			assertTrue(v.yaw() < -60 && v.yaw() > -120, "yaw " + v.yaw());
		}
	}

	@Test
	void theWholeBlockIsInFrame() {
		for (Box site : new Box[] {SiteOverlook.FALLBACK, Box.of(50, 64, 10, 32, 16, 32), Box.of(-200, 70, 300, 64, 24, 20)}) {
			View v = SiteOverlook.of(site, BUTTON_X, BUTTON_Z);
			for (int x : new int[] {site.minX(), site.maxX()}) {
				for (int y : new int[] {site.minY(), site.maxY()}) {
					for (int z : new int[] {site.minZ(), site.maxZ()}) {
						double a = angleTo(v, x, y, z);
						assertTrue(a < SiteOverlook.HALF_VIEW, "corner " + x + " " + y + " " + z + " is " + a + " degrees off centre from " + v);
					}
				}
			}
		}
	}

	@Test
	void facesTheSiteFromWhicheverSideThePlayerIsOn() {
		Box site = SiteOverlook.FALLBACK;
		assertEquals(90, SiteOverlook.of(site, 500, centreZ(site)).yaw(), 1e-3); // from the east, looking west
		assertEquals(0, SiteOverlook.of(site, centreX(site), -500).yaw(), 1e-3); // from the north, looking south
		assertEquals(180, Math.abs(SiteOverlook.of(site, centreX(site), 500).yaw()), 1e-3); // from the south, looking north
	}

	@Test
	void aPointOverTheMiddleStandsWest() {
		Box site = SiteOverlook.FALLBACK;
		View v = SiteOverlook.of(site, centreX(site), centreZ(site));
		assertTrue(v.x() < centreX(site));
		assertEquals(centreZ(site), v.z(), 1e-9);
		assertEquals(-90, v.yaw(), 1e-3);
	}

	@Test
	void aSmallSlotKeepsTheMinimumDistance() {
		Box slot = Box.of(0, 64, 0, 4, 4, 4);
		View v = SiteOverlook.of(slot, -100, 2);
		double dx = 2 - v.x();
		double dy = 65 - v.y();
		double dz = 2 - v.z();
		assertEquals(SiteOverlook.MIN_DISTANCE, Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-9);
	}

	@Test
	void aHugeSiteKeepsTheEyeUnderTheLimitAndStillAims() {
		Box city = Box.of(0, 64, 0, 2000, 30, 2000);
		View v = SiteOverlook.of(city, -100, 1000);
		assertEquals(SiteOverlook.MAX_EYE_Y, v.y(), 1e-9);
		assertEquals(0, angleTo(v, 1000, 65, 1000), 1e-3);
	}
}
