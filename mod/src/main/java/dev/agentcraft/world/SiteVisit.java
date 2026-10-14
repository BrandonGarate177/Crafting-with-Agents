package dev.agentcraft.world;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.level.GameType;

/**
 * A player's trip from the studio to the build site and back (server thread). {@link #visit} remembers
 * where the player stood and how, then puts them in spectator at an overlook; {@link #back} undoes it
 * exactly. Only the player moves: agents are client-side and keep their stations.
 */
public final class SiteVisit {
	private record Return(ServerLevel level, double x, double y, double z, float yaw, float pitch, GameType mode, boolean flying) {
	}

	private static final Map<UUID, Return> AWAY = new ConcurrentHashMap<>();

	private SiteVisit() {
	}

	public static void init() {
		// Leaving the game from the site saves the player back in the studio (position only: HqWorld puts a
		// spectator back in creative when they join).
		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
			ServerPlayer sp = handler.getPlayer();
			Return r = AWAY.remove(sp.getUUID());
			if (r != null && r.level() == sp.level()) {
				sp.snapTo(r.x(), r.y(), r.z(), r.yaw(), r.pitch());
			}
		});
	}

	/**
	 * Spectate the site from {@code view} (an eye position). A second visit while away only moves the
	 * camera; the way back still leads to where the first one started.
	 */
	public static void visit(ServerPlayer sp, SiteOverlook.View view, Component hint) {
		AWAY.computeIfAbsent(sp.getUUID(), k -> new Return(sp.level(), sp.getX(), sp.getY(), sp.getZ(), sp.getYRot(), sp.getXRot(), sp.gameMode(),
			sp.getAbilities().flying));
		if (sp.getCamera() != sp) {
			sp.setCamera(sp);
		}
		if (sp.gameMode() != GameType.SPECTATOR) {
			sp.setGameMode(GameType.SPECTATOR);
		}
		double feetY = view.y() - sp.getEyeHeight(Pose.STANDING);
		sp.teleportTo(sp.level(), view.x(), feetY, view.z(), Set.of(), view.yaw(), view.pitch(), true);
		sp.sendOverlayMessage(hint);
	}

	/** Back to where the visit started, in the game mode the player had; false when they are not away. */
	public static boolean back(ServerPlayer sp) {
		Return r = AWAY.remove(sp.getUUID());
		if (r == null) {
			return false;
		}
		GameType mode = r.mode() == GameType.SPECTATOR ? GameType.CREATIVE : r.mode();
		if (sp.gameMode() != mode) {
			sp.setGameMode(mode);
		}
		if (sp.getAbilities().mayfly) {
			sp.getAbilities().flying = r.flying();
			sp.onUpdateAbilities();
		}
		sp.teleportTo(r.level(), r.x(), r.y(), r.z(), Set.of(), r.yaw(), r.pitch(), true);
		return true;
	}
}
