import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: "#00E5FF" }}>
      <Tabs.Screen
        name="scan"
        options={{ title: "Escanear", tabBarIcon: () => null }}
      />
      <Tabs.Screen
        name="sessions"
        options={{ title: "Sesiones", tabBarIcon: () => null }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Ajustes", tabBarIcon: () => null }}
      />
    </Tabs>
  );
}
