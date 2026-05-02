import matplotlib.pyplot as plt
from sumolib import net

# Chargement du réseau généré par netgenerate
network = net.readNet('data/test.net.xml')

plt.figure(figsize=(10, 10))

# Dessiner chaque rue (edge)
for edge in network.getEdges():
    shape = edge.getShape()
    x, y = zip(*shape)
    plt.plot(x, y, color='blue', linewidth=1)

# Dessiner les intersections (nodes)
for node in network.getNodes():
    plt.scatter(node.getCoord()[0], node.getCoord()[1], color='red', s=20)

plt.title("Visualisation de la Grille de Simulation 10x10")
plt.xlabel("Position X (m)")
plt.ylabel("Position Y (m)")
plt.grid(True)
plt.axis('equal')

# Sauvegarde
plt.savefig('data/grid_map.png')
print("Image générée avec succès dans data/grid_map.png")