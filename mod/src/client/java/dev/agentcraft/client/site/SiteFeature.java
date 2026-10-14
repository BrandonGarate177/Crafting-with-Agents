package dev.agentcraft.client.site;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.BuildSite;
import dev.agentcraft.client.foreman.Protocol.Zone;
import dev.agentcraft.client.foreman.Protocol.ZoneBox;
import dev.agentcraft.client.hud.Keys;
import dev.agentcraft.client.ui.Guard;
import dev.agentcraft.client.world.ServerTasks;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.world.SiteOverlook;
import dev.agentcraft.world.SiteVisit;
import java.util.UUID;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import org.jspecify.annotations.Nullable;

/**
 * The site button by the atrium's south door. A click puts the player in spectator over the build site
 * (the Foreman's site.json, from the snapshot), looking down at the block; the "back to the studio" key
 * ({@code B}, rebindable) returns them to where they pressed it, in creative. The click is handled on the
 * client like the stations and run on the integrated server; only the player moves.
 */
public final class SiteFeature {
	private static boolean toldFallback;

	private SiteFeature() {
	}

	public static void init() {
		Keys.ensureRegistered();
		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			if (!level.isClientSide() || player.isSecondaryUseActive()) {
				return InteractionResult.PASS;
			}
			Anchor button = Anchors.get(AnchorNames.SITE_BUTTON);
			if (button == null || !hit.getBlockPos().equals(button.blockPos())) {
				return InteractionResult.PASS;
			}
			Guard.run("site.visit", () -> visit(player));
			return InteractionResult.FAIL;
		});
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("site.tick", () -> {
			while (Keys.studio.consumeClick()) {
				if (mc.player != null) {
					onServer(mc.player.getUUID(), SiteVisit::back);
				}
			}
		}));
	}

	private static void visit(Player player) {
		SiteOverlook.Box box = box(Foreman.state().site());
		if (box == null) {
			box = SiteOverlook.FALLBACK;
			if (!toldFallback) {
				toldFallback = true;
				AgentCraft.LOGGER.info("Site button: no site from the Foreman yet, looking at the default site instead");
			}
		}
		SiteOverlook.View view = SiteOverlook.of(box, player.getX(), player.getZ());
		Component hint = Component.literal("Press " + Keys.label(Keys.studio) + " to go back to the studio");
		onServer(player.getUUID(), sp -> SiteVisit.visit(sp, view, hint));
	}

	/** The bounding box of every slot, or null when there is no site or it has no slots. */
	static SiteOverlook.@Nullable Box box(@Nullable BuildSite site) {
		if (site == null) {
			return null;
		}
		SiteOverlook.Box out = null;
		for (Zone z : site.zones()) {
			ZoneBox b = z.box();
			SiteOverlook.Box one = SiteOverlook.Box.of(b.x(), b.y(), b.z(), b.w(), b.h(), b.d());
			out = out == null ? one : out.union(one);
		}
		return out;
	}

	private static void onServer(UUID player, Consumer<ServerPlayer> task) {
		ServerTasks.run(level -> {
			ServerPlayer sp = level.getServer().getPlayerList().getPlayer(player);
			if (sp != null) {
				task.accept(sp);
			}
		});
	}
}
