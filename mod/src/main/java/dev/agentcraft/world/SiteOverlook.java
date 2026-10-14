package dev.agentcraft.world;

/**
 * Where to put the camera to look at the build site: above the slots and pulled back toward the
 * studio, aimed at the middle of their bounding box, far enough out that the whole block and a ring of
 * city around it fit in a vanilla 70 degree view. Pure maths, no world access.
 */
public final class SiteOverlook {
	/** How far the camera looks down, in degrees. */
	static final double PITCH = 40;
	/** Half the vertical view the block has to fit in: under vanilla's 35, so the edges keep a margin. */
	static final double HALF_VIEW = 30;
	/** Frame this many times the block's radius, so the streets around it show too. */
	static final double SURROUND = 1.5;
	/** Never closer than this, so a single small slot still reads as a place in the city. */
	static final double MIN_DISTANCE = 24;
	/** Keep the eye under the build limit, whatever the site's size. */
	static final double MAX_EYE_Y = 300;

	/**
	 * The default site in foreman/src/site.ts (origin 30 64 10, slots spanning 32 by 32, 16 high), for
	 * when no snapshot has brought the real one yet.
	 */
	public static final Box FALLBACK = Box.of(30, 64, 10, 32, 16, 32);

	/** A block box: min corner inclusive, max corner exclusive (so a 1-wide slot has maxX = minX + 1). */
	public record Box(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
		/** A box from its lowest corner and size along x, y, z (the protocol's ZoneBox order is w, h, d). */
		public static Box of(int x, int y, int z, int w, int h, int d) {
			return new Box(x, y, z, x + w, y + h, z + d);
		}

		public Box union(Box o) {
			return new Box(Math.min(minX, o.minX), Math.min(minY, o.minY), Math.min(minZ, o.minZ), Math.max(maxX, o.maxX), Math.max(maxY, o.maxY),
				Math.max(maxZ, o.maxZ));
		}
	}

	/** An eye position and Minecraft look angles (yaw 0 = south, 90 = west; pitch positive = down). */
	public record View(double x, double y, double z, float yaw, float pitch) {
	}

	private SiteOverlook() {
	}

	/**
	 * The overlook of {@code box} seen from the side of ({@code fromX}, {@code fromZ}), usually where the
	 * player pressed the button. A point straight over the box's middle has no side; the camera then
	 * stands to the west.
	 */
	public static View of(Box box, double fromX, double fromZ) {
		double cx = (box.minX() + box.maxX()) / 2.0;
		double cz = (box.minZ() + box.maxZ()) / 2.0;
		// aim at the ground's top face (the slot's y is the ground block)
		double cy = box.minY() + 1;
		double w = box.maxX() - box.minX();
		double d = box.maxZ() - box.minZ();
		double radius = Math.sqrt(w * w + d * d) / 2;
		double dist = Math.max(MIN_DISTANCE, SURROUND * radius / Math.sin(Math.toRadians(HALF_VIEW)));

		double ux = fromX - cx;
		double uz = fromZ - cz;
		double len = Math.sqrt(ux * ux + uz * uz);
		if (len < 1e-6) {
			ux = -1;
			uz = 0;
		} else {
			ux /= len;
			uz /= len;
		}
		double back = dist * Math.cos(Math.toRadians(PITCH));
		double ex = cx + ux * back;
		double ez = cz + uz * back;
		double ey = Math.min(MAX_EYE_Y, cy + dist * Math.sin(Math.toRadians(PITCH)));

		// angles from the real eye to the target (the same formula as the DevBridge camera's lookAt)
		double dx = cx - ex;
		double dy = cy - ey;
		double dz = cz - ez;
		float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		float pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
		return new View(ex, ey, ez, yaw, pitch);
	}
}
